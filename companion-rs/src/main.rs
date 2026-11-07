//! Outbound-only agent-desktop companion.
//!
//! Rust port of `app/companion/cua-companion.mjs`, retargeted from CUA
//! Driver to `agent-desktop mcp` as the backing driver, and compiled to a
//! native binary per platform instead of running under Bun's JIT (which is
//! what the AVX2 workaround at the top of the old `.mjs` exists to fight).
//!
//! It deliberately exposes no shell, filesystem, browser, clipboard, or
//! generic MCP forwarding surface: only the commands in `tools::SAFE_COMMANDS`
//! are ever dispatched, and the server independently enforces the same
//! policy (defense in depth, not a single point of trust).

mod driver;
mod protocol;
mod state;
mod tools;

use driver::Driver;
use futures_util::{SinkExt, StreamExt};
use protocol::{Incoming, Outgoing, Readiness, PROTOCOL_VERSION};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

struct Args {
    server: String,
    pairing_token: Option<String>,
    device_name: String,
    state_path: std::path::PathBuf,
    executable: String,
    help: bool,
    grant_permissions: bool,
}

const HELP_TEXT: &str = r#"gajae-agent-desktop-companion - outbound-only remote computer-use companion

USAGE:
  agent-desktop-companion --server=<host> --pair=<token> [options]
  agent-desktop-companion --server=<host> [options]        (reconnect with a stored credential)
  agent-desktop-companion --grant-permissions               (macOS/Linux: check/request accessibility access)
  agent-desktop-companion --help

OPTIONS:
  --server=<host>        Required to connect. Bare domain (e.g. gjc.example.com) is
                          expanded to wss://<host>/remote-cua automatically. Pass a full
                          ws://... or wss://... URL instead for a non-default port/path,
                          or ws://localhost for local development (plain ws:// is refused
                          for any other host).
  --pair=<token>         One-time pairing token from the server's Settings > Automation >
                          Remote devices page. Only needed for the first connection; once
                          paired, the issued credential is stored and reused automatically.
  --name=<name>          Device name shown in the server's device list. Defaults to this
                          machine's hostname.
  --state=<path>         Where the paired device credential is stored. Defaults to this
                          OS's standard config directory.
  --executable=<path>    Path to the agent-desktop CLI, if not on PATH. Defaults to
                          "agent-desktop".
  --grant-permissions    Checks current OS automation/accessibility permission state and,
                          if not already granted, performs one harmless read-only desktop
                          action to trigger the OS permission prompt. Does not require
                          --server or --pair; safe to run on its own before pairing, or
                          again later if a tool call ever fails with a permission error.
  --help                 Show this message.

EXAMPLES:
  agent-desktop-companion --server=gjc.example.com --pair=AbCdEf123...
  agent-desktop-companion --server=gjc.example.com
  agent-desktop-companion --grant-permissions
"#;

fn parse_args() -> Args {
    let mut server = String::new();
    let mut pairing_token = None;
    let mut device_name = hostname();
    let mut state_path = state::default_state_path();
    let mut executable = "agent-desktop".to_string();
    let mut help = false;
    let mut grant_permissions = false;
    for arg in std::env::args().skip(1) {
        if arg == "--help" || arg == "-h" {
            help = true;
        } else if arg == "--grant-permissions" {
            grant_permissions = true;
        } else if let Some(value) = arg.strip_prefix("--server=") {
            server = value.to_string();
        } else if let Some(value) = arg.strip_prefix("--pair=") {
            pairing_token = Some(value.to_string());
        } else if let Some(value) = arg.strip_prefix("--name=") {
            device_name = value.to_string();
        } else if let Some(value) = arg.strip_prefix("--state=") {
            state_path = std::path::PathBuf::from(value);
        } else if let Some(value) = arg.strip_prefix("--executable=") {
            executable = value.to_string();
        }
    }
    Args { server, pairing_token, device_name, state_path, executable, help, grant_permissions }
}

/// Real device hostname, used as the default `--name`. Neither `HOSTNAME`
/// nor `COMPUTERNAME` is set in a typical interactive macOS/Linux shell
/// (confirmed live: every macOS pairing without an explicit `--name` showed
/// up server-side as "unknown-device"), so this shells out to the platform's
/// own hostname lookup instead of relying on environment variables that are
/// mostly a Windows-only convention.
fn hostname() -> String {
    if let Ok(value) = std::env::var("COMPUTERNAME") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    if let Ok(output) = std::process::Command::new("hostname").output() {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    if let Ok(value) = std::env::var("HOSTNAME") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    "unknown-device".to_string()
}

fn os_label() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// `--server` accepts a bare domain; `wss://` and the `/remote-cua` path are
/// filled in automatically so the user never has to know the wire shape.
/// Pass a full URL instead (non-default port/path, or explicit `ws://` for
/// local development) and it is used as given. Mirrors the equivalent logic
/// in the retired `cua-companion.mjs`.
fn normalize_server_url(server: &str) -> Result<url::Url, String> {
    let candidate = if server.starts_with("ws://") || server.starts_with("wss://") {
        server.to_string()
    } else {
        format!("wss://{server}")
    };
    let mut parsed = url::Url::parse(&candidate).map_err(|cause| format!("invalid --server value: {cause}"))?;
    if parsed.path() == "/" || parsed.path().is_empty() {
        parsed.set_path("/remote-cua");
    }
    if parsed.scheme() == "ws" {
        let host = parsed.host_str().unwrap_or("");
        let is_localhost = host == "localhost" || host == "127.0.0.1" || host == "::1";
        if !is_localhost {
            return Err("ws:// is limited to localhost development; use wss:// for any other host.".to_string());
        }
    }
    Ok(parsed)
}

#[tokio::main]
async fn main() {
    // rustls needs an explicit default crypto provider installed once at
    // startup; without it, the first TLS (wss://) connect panics instead of
    // erroring - only observable by actually making a real wss:// connection.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = parse_args();
    if args.help {
        println!("{HELP_TEXT}");
        std::process::exit(0);
    }
    if args.grant_permissions {
        let driver = Arc::new(Driver::new(args.executable.clone()));
        grant_permissions(&driver).await;
        std::process::exit(0);
    }
    if args.server.is_empty() {
        eprintln!("[error] --server is required: pass your Gajae server's address, e.g. --server=gjc.example.com (run with --help for all options).");
        std::process::exit(1);
    }
    if let Err(cause) = normalize_server_url(&args.server) {
        eprintln!("[error] {cause}");
        std::process::exit(1);
    }
    let driver = Arc::new(Driver::new(args.executable.clone()));
    maybe_prompt_permissions(&driver).await;
    let state = Arc::new(Mutex::new(state::load(&args.state_path).await));

    loop {
        match connect_once(&args, &driver, &state).await {
            Ok(()) => {}
            Err(cause) if cause.starts_with("rejected:") => {
                eprintln!("[error] {}", cause.trim_start_matches("rejected:"));
                eprintln!("[error] The server rejected this connection (bad pairing token, or the server itself refused it). Exiting instead of retrying forever against a connection that cannot succeed. If --pair=<token> was used, get a fresh token and try again; otherwise just run with --server again to register.");
                std::process::exit(1);
            }
            Err(cause) => {
                eprintln!("[info] Disconnected ({cause}). Retrying in 2s...");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn connect_once(
    args: &Args,
    driver: &Arc<Driver>,
    state: &Arc<Mutex<Option<state::DeviceState>>>,
) -> Result<(), String> {
    let url = normalize_server_url(&args.server)?;
    let (socket, response) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|cause| format!("connect failed: {cause}"))?;
    if response.status().as_u16() >= 400 {
        return Err(format!("rejected:server rejected the connection (HTTP {})", response.status()));
    }
    let (mut write, mut read) = socket.split();
    println!("[info] Connected. Authenticating...");

    let current_state = state.lock().await.clone();
    let hello = Outgoing::Hello {
        protocol_version: PROTOCOL_VERSION,
        device_id: current_state.as_ref().map(|s| s.device_id.clone()),
        credential: current_state.as_ref().map(|s| s.credential.clone()),
        pairing_token: if current_state.is_none() { args.pairing_token.clone() } else { None },
        device_name: if current_state.is_none() { Some(args.device_name.clone()) } else { None },
        os: if current_state.is_none() { Some(os_label()) } else { None },
    };
    send(&mut write, &hello).await?;

    let completed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut printed_pending_notice = false;

    while let Some(message) = read.next().await {
        let message = message.map_err(|cause| cause.to_string())?;
        if let Message::Close(frame) = &message {
            let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0);
            let reason = frame.as_ref().map(|f| f.reason.to_string()).unwrap_or_default();
            // 1008 (policy violation) is this server's rejection code for a
            // bad/expired/already-used pairing token or an unknown, revoked,
            // or disabled device credential - none of those become true by
            // retrying unchanged, so surface it as a terminal rejection
            // instead of looping "Disconnected ... Retrying in 2s" forever
            // (previously indistinguishable from a transient network blip).
            if code == 1008 {
                return Err(format!("rejected:server closed the connection: {reason}"));
            }
            continue;
        }
        let Message::Text(text) = message else { continue };
        let Ok(incoming) = serde_json::from_str::<Incoming>(&text) else { continue };
        match incoming {
            Incoming::Paired { device_id, credential, .. } => {
                let new_state = state::DeviceState { device_id: device_id.clone(), credential: credential.clone() };
                state::save(&args.state_path, &new_state).await.map_err(|cause| cause.to_string())?;
                *state.lock().await = Some(new_state);
                println!("[info] Registered. Waiting for approval - check the web UI's Settings > Automation > Remote devices page and Trust this device.");
                printed_pending_notice = true;
                send_readiness(&mut write, &device_id, args, driver).await?;
            }
            Incoming::Pong { pending_approval, .. } => {
                if pending_approval && !printed_pending_notice {
                    println!("[info] Connected but not yet approved - check the web UI's Settings > Automation > Remote devices page and Trust this device.");
                    printed_pending_notice = true;
                } else if !pending_approval {
                    printed_pending_notice = false;
                }
                if let Some(active) = state.lock().await.clone() {
                    send_readiness(&mut write, &active.device_id, args, driver).await?;
                }
            }
            Incoming::Disconnect { reason, .. } => {
                println!("[info] Server disconnected this device: {reason}");
                return Ok(());
            }
            Incoming::Cancel { .. } => {
                // Best-effort: this companion does not track in-flight
                // cancellation tokens yet; the request will simply complete
                // or fail on its own.
            }
            Incoming::ComputerRequest { request_id, device_id, tool, arguments, deadline, .. } => {
                let already = {
                    let mut set = completed.lock().await;
                    let is_new = set.insert(request_id.clone());
                    !is_new
                };
                let active_device_id = state.lock().await.as_ref().map(|s| s.device_id.clone());
                let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
                let refusal = if active_device_id.as_deref() != Some(device_id.as_str())
                {
                    Some("device ID mismatch".to_string())
                } else if already {
                    Some("duplicate request ID".to_string())
                } else if now_ms >= deadline {
                    Some("expired deadline".to_string())
                } else if !tools::is_safe_command(&tool) {
                    Some("cua_policy_denied: command not in companion allowlist".to_string())
                } else {
                    None
                };
                let result = match &refusal {
                    Some(reason) => {
                        eprintln!("[warn] Refused {tool}: {reason}");
                        Err(reason.clone())
                    }
                    None => {
                        println!("[info] Running {tool} ...");
                        match driver.call(&tool, arguments).await {
                            Ok(value) => {
                                println!("[info] {tool} completed.");
                                Ok(value)
                            }
                            Err(cause) => {
                                eprintln!("[error] {tool} failed: {cause}");
                                Err(cause)
                            }
                        }
                    }
                };
                let outgoing = Outgoing::ComputerResult {
                    protocol_version: PROTOCOL_VERSION,
                    request_id,
                    device_id,
                    result: result.as_ref().ok().cloned(),
                    error: result.err(),
                };
                send(&mut write, &outgoing).await?;
            }
        }
    }
    Ok(())
}

/// Runs once at startup on the connect path (never for a standalone
/// `--grant-permissions` invocation, which calls `grant_permissions`
/// directly) so a first-time user is not left silently unable to automate
/// anything with no explanation. Best-effort and non-fatal: a probe failure
/// here just falls through to the normal in-session readiness reporting,
/// and `--grant-permissions` remains available to run manually at any time.
async fn maybe_prompt_permissions(driver: &Arc<Driver>) {
    let granted = driver.call("desktop_permissions", serde_json::json!({})).await
        .ok()
        .and_then(|value| all_permissions_granted(&value))
        .unwrap_or(true);
    if !granted {
        eprintln!("[warn] agent-desktop does not yet have the OS permissions it needs on this machine.");
        grant_permissions(driver).await;
    }
}

/// Reads current permission state via the `desktop_permissions` MCP tool
/// and, if anything is missing, performs one harmless read-only action
/// (`desktop_list_apps`) to trigger the OS's native permission prompt(s).
/// agent-desktop (like its CUA Driver predecessor) has no CLI/MCP command
/// that requests permissions directly; the OS only shows the prompt the
/// first time a real accessibility-API call is actually attempted.
async fn grant_permissions(driver: &Arc<Driver>) {
    match driver.call("desktop_permissions", serde_json::json!({})).await {
        Ok(value) => {
            if all_permissions_granted(&value) == Some(true) {
                println!("[info] All required permissions are already granted.");
                return;
            }
            if let Some(data) = value.get("structuredContent").and_then(|v| v.get("data")).and_then(serde_json::Value::as_object) {
                for (name, entry) in data {
                    let state = entry.get("state").and_then(serde_json::Value::as_str).unwrap_or("unknown");
                    println!("[info]   {name}: {state}");
                }
            } else {
                println!("[info] Current permission state: {value}");
            }
        }
        Err(cause) => println!("[warn] Could not read current permission state: {cause}"),
    }
    println!("[info] Attempting a harmless read-only desktop action to trigger the OS permission prompt...");
    match driver.call("desktop_list_apps", serde_json::json!({})).await {
        Ok(_) => println!("[info] Action completed. If a system permission dialog appeared, approve it, then re-run --grant-permissions to confirm."),
        Err(cause) => println!("[warn] Action failed ({cause}). If a system permission dialog appeared, approve it in System Settings (macOS: Privacy & Security > Accessibility and Screen Recording) or your Linux desktop's permission manager, then re-run --grant-permissions to confirm."),
    }
}

/// `desktop_permissions`'s envelope nests the real check under
/// `structuredContent.data`, each field shaped `{state: "granted" | ...}`.
/// Returns `None` when the shape is unrecognized (treated as "unknown", not
/// "denied", by callers) and `Some(false)` only when a field explicitly
/// says it is not granted.
fn all_permissions_granted(value: &serde_json::Value) -> Option<bool> {
    let data = value.get("structuredContent")?.get("data")?.as_object()?;
    if data.is_empty() {
        return None;
    }
    Some(data.values().all(|entry| {
        let state = entry.get("state").and_then(serde_json::Value::as_str).unwrap_or("");
        state == "granted" || state == "not_required"
    }))
}

async fn send_readiness(
    write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    device_id: &str,
    args: &Args,
    driver: &Arc<Driver>,
) -> Result<(), String> {
    let _ = device_id;
    // A cheap read-only probe to report driver availability, matching the
    // old companion's readiness ping. `desktop_list_apps` is the live MCP
    // tool name (not the CLI command name `list-apps`); succeeding proves
    // agent-desktop is installed, speaking MCP, and can reach a display.
    let schema_supported = driver.call("desktop_list_apps", serde_json::json!({})).await.is_ok();
    let readiness = Readiness {
        driver_version: None,
        schema_supported,
        daemon: if schema_supported { "running" } else { "unknown" },
        safe_tools: tools::SAFE_COMMANDS.to_vec(),
        device_name: args.device_name.clone(),
        os: os_label(),
    };
    let state = if schema_supported { "agent-desktop ready" } else { "agent-desktop not available - tool calls will fail" };
    println!("[info] Status: device \"{}\" ({}) - {state} - {} commands reviewed.", args.device_name, os_label(), tools::SAFE_COMMANDS.len());
    send(write, &Outgoing::Readiness { protocol_version: PROTOCOL_VERSION, readiness }).await
}

async fn send<S>(write: &mut S, message: &Outgoing) -> Result<(), String>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = serde_json::to_string(message).expect("serializable");
    write.send(Message::Text(text)).await.map_err(|cause| cause.to_string())
}
