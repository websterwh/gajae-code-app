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
mod install;
mod local;
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
    install_agent_desktop: bool,
    local_shell: bool,
}

const HELP_TEXT: &str = r#"gajae-agent-desktop-companion - outbound-only remote computer-use companion

USAGE:
  agent-desktop-companion --server=<host> --pair=<token> [options]
  agent-desktop-companion --server=<host> [options]        (reconnect with a stored credential)
  agent-desktop-companion --server=<host> --shell    (also allow shell/file access to this machine)
  agent-desktop-companion --install-agent-desktop           (download and install agent-desktop itself)
  agent-desktop-companion --grant-permissions               (macOS/Linux: check/request accessibility access)
  agent-desktop-companion --help

OPTIONS:
  --server=<host>        Required to connect. Bare domain (e.g. gjc.example.com) is
                          expanded to wss://<host>/remote-cua automatically. Pass a full
                          ws://... or wss://... URL instead for a non-default port/path,
                          or ws://localhost for local development (plain ws:// is refused
                          for any other host).

  --pair=<token>         Pairing token from the server's Settings > Automation > Remote
                          devices page. Retried on every connection attempt, not just the
                          first - a stored credential is tried first if one exists, and
                          this token is only consumed as a fallback if that credential is
                          dead (device removed/untrusted too long), or if no credential is
                          stored yet at all. A token-paired device is trusted immediately;
                          a --server-only registration (no --pair) still needs to be
                          Trusted in Settings before it can run anything.
  --name=<name>          Device name shown in the server's device list. Defaults to this
                          machine's hostname.
  --state=<path>         Where the paired device credential is stored. Defaults to this
                          OS's standard config directory.
  --executable=<path>    Path to the agent-desktop CLI. Defaults to a prior
                          --install-agent-desktop's location if one exists, otherwise
                          plain "agent-desktop" (resolved via PATH).
  --install-agent-desktop
                          Downloads the latest agent-desktop release directly from
                          https://github.com/vercel-labs/agent-desktop (no Node/npm
                          required), verifies its published sha256, and installs it
                          under this OS's config directory. Does not require --server
                          or --pair. Once installed, --executable defaults to it
                          automatically - no PATH changes or npm/brew install needed.
  --grant-permissions    Checks current OS automation/accessibility permission state and,
                          if not already granted, performs harmless read-only desktop
                          actions to trigger the OS permission prompts. Does not require
                          --server or --pair; safe to run on its own before pairing, or
                          again later if a tool call ever fails with a permission error.
                          On the normal --server connect path this also runs automatically,
                          exactly once, right after this device is approved in Settings -
                          never before approval.
  --shell          Also let the paired app use this machine's shell and files,
                          the way running the GJC CLI here would: local_exec (a shell
                          command), local_read_file, local_write_file,
                          local_list_files and local_search. Off by default and never
                          enabled by any other flag - a companion started without it
                          refuses every local_* request, whatever the server asks.
                          Only use it with a server you would trust with this machine:
                          it gives the agent the reach your own terminal has, within
                          the documented command, write, output and timeout caps.
  --help                 Show this message.

EXAMPLES:
  agent-desktop-companion --install-agent-desktop
  agent-desktop-companion --server=gjc.example.com --pair=AbCdEf123...
  agent-desktop-companion --server=gjc.example.com
  agent-desktop-companion --grant-permissions
  agent-desktop-companion --server=gjc.example.com --pair=AbCdEf123... --shell
"#;

fn parse_args() -> Args {
    let mut server = String::new();
    let mut pairing_token = None;
    let mut device_name = hostname();
    let mut state_path = state::default_state_path();
    // A prior --install-agent-desktop takes effect with no further flags
    // needed: an explicit --executable (checked below, after this loop)
    // still overrides it.
    let mut executable = install::find_installed().map(|path| path.display().to_string()).unwrap_or_else(|| "agent-desktop".to_string());
    let mut help = false;
    let mut grant_permissions = false;
    let mut install_agent_desktop = false;
    let mut local_shell = false;
    for arg in std::env::args().skip(1) {
        if arg == "--help" || arg == "-h" {
            help = true;
        } else if arg == "--grant-permissions" {
            grant_permissions = true;
        } else if arg == "--install-agent-desktop" {
            install_agent_desktop = true;
        } else if arg == "--shell" {
            local_shell = true;
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
    Args { server, pairing_token, device_name, state_path, executable, help, grant_permissions, install_agent_desktop, local_shell }
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
    if args.install_agent_desktop {
        match install::install().await {
            Ok(_) => std::process::exit(0),
            Err(cause) => { eprintln!("[error] {cause}"); std::process::exit(1); }
        }
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
    // No agent-desktop permission probe runs here: this would touch the
    // local machine (and can pop a native OS permission dialog) before the
    // connection is even authenticated, let alone approved. It is deferred
    // to the first post-approval pong inside connect_once instead.
    let driver = Arc::new(Driver::new(args.executable.clone()));
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
    // An explicit --pair=<token> is always sent, even when a stored
    // credential exists: typing a fresh --pair token is a deliberate
    // "start over" signal from the user, and the previous behavior of only
    // ever sending it when no local state file existed meant a stale
    // stored credential (left behind by a device that was later removed or
    // revoked) silently discarded any token the user had just typed in -
    // the companion kept authenticating with the dead credential instead
    // and the token went completely unused. The server tries the stored
    // credential first regardless and only falls back to the token if that
    // credential turns out to be dead, so a *working* stored credential is
    // still never displaced by an incidental leftover --pair flag.
    let hello = Outgoing::Hello {
        protocol_version: PROTOCOL_VERSION,
        device_id: current_state.as_ref().map(|s| s.device_id.clone()),
        credential: current_state.as_ref().map(|s| s.credential.clone()),
        pairing_token: args.pairing_token.clone(),
        device_name: Some(args.device_name.clone()),
        os: Some(os_label()),
    };
    send(&mut write, &hello).await?;

    let completed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut printed_pending_notice = false;
    let mut permissions_checked = false;

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
                // No readiness probe here: approval state is reported by the
                // pong that follows immediately after, and agent-desktop is
                // never touched for an unapproved device (see below).
            }
            Incoming::Pong { pending_approval, .. } => {
                if pending_approval {
                    if !printed_pending_notice {
                        println!("[info] Connected but not yet approved - check the web UI's Settings > Automation > Remote devices page and Trust this device.");
                        printed_pending_notice = true;
                    }
                    // Never probes agent-desktop (no tool call, no
                    // permission prompt, nothing loaded) for a device that
                    // cannot dispatch anything yet - there is no reason to
                    // touch the local machine at all before a human has
                    // actually approved this connection.
                    continue;
                }
                if printed_pending_notice {
                    println!("[info] Approved. Loading agent-desktop...");
                    printed_pending_notice = false;
                }
                if !permissions_checked {
                    // Deferred from startup: the very first thing this
                    // device does with agent-desktop (and the only place
                    // that can pop a native OS permission dialog) happens
                    // only now, once per run, after a human has actually
                    // approved this connection - never before approval,
                    // and never repeated every reconnect/readiness round.
                    permissions_checked = true;
                    maybe_prompt_permissions(driver).await;
                }
                if let Some(active) = state.lock().await.clone() {
                    send_readiness(&mut write, &active.device_id, args, driver).await?;
                }
            }
            Incoming::Disconnect { reason, .. } => {
                println!("[info] Server disconnected this device: {reason}");
                return Ok(());
            }
            Incoming::Approved { .. } => {
                // Pushed live the instant Trust is clicked on an
                // already-connected pending device - without this there is
                // no other signal in between reconnects.
                if printed_pending_notice {
                    println!("[info] Approved. Loading agent-desktop...");
                    printed_pending_notice = false;
                }
                if !permissions_checked {
                    permissions_checked = true;
                    maybe_prompt_permissions(driver).await;
                }
                if let Some(active) = state.lock().await.clone() {
                    send_readiness(&mut write, &active.device_id, args, driver).await?;
                }
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
                } else if !tools::is_safe_command(&tool) && !(args.local_shell && local::is_local_tool(&tool)) {
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
                        // `--shell` tools never touch agent-desktop: they run
                        // on this machine directly. The flag was already enforced
                        // by the allowlist check above.
                        let outcome = if local::is_local_tool(&tool) {
                            local::call(&tool, &arguments).await
                        } else {
                            driver.call(&tool, arguments).await
                        };
                        match outcome {
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
/// directly), and only after this device has actually been approved
/// (exactly once per run, on the first non-pending pong) so a device that
/// is not yet trusted never touches agent-desktop or pops a native OS
/// permission dialog before a human has approved it in Settings.
/// Best-effort and non-fatal: a probe failure here just falls through to
/// the normal in-session readiness reporting, and `--grant-permissions`
/// remains available to run manually at any time.
async fn maybe_prompt_permissions(driver: &Arc<Driver>) {
    let granted = driver.call("desktop_permissions", serde_json::json!({})).await
        .ok()
        .and_then(|value| all_permissions_granted(&value));
    if granted == Some(false) {
        eprintln!("[warn] agent-desktop does not yet have the OS permissions it needs on this machine.");
        grant_permissions(driver).await;
    }
}

/// Reads current permission state via the `desktop_permissions` MCP tool
/// and, if anything is missing, calls it again with `request: true` (and
/// `guide: true` on macOS). This is the tool's own documented request
/// mechanism - confirmed against its real input schema, which accepts
/// exactly these two booleans - not a side-effecting read-only action
/// that happens to also touch the accessibility API. The companion's
/// earlier approach (calling `desktop_list_apps`, then `desktop_snapshot`/
/// `desktop_screenshot`) never actually requested anything: `list_apps`
/// never touches the accessibility API at all, and even the AX-tree/
/// screen-capture calls only *preflight* existing access on macOS, they
/// do not drive the OS consent flow the way `request: true` does -
/// `guide: true` additionally opens System Settings with an on-screen
/// walkthrough of exactly which app to allow.
async fn grant_permissions(driver: &Arc<Driver>) {
    if report_permissions(driver).await == Some(true) {
        println!("[info] All required permissions are already granted.");
        return;
    }
    println!("[info] Requesting missing permissions...");
    let args = if std::env::consts::OS == "macos" {
        serde_json::json!({ "request": true, "guide": true })
    } else {
        serde_json::json!({ "request": true })
    };
    match driver.call("desktop_permissions", args).await {
        Ok(_) => {
            println!("[info] Request completed. If a system permission dialog or System Settings window appeared, approve it, then re-run --grant-permissions to confirm.");
            report_permissions(driver).await;
        }
        Err(cause) => println!("[warn] Request failed ({cause}). Approve permissions manually in System Settings (macOS: Privacy & Security > Accessibility and Screen Recording) or your Linux desktop's permission manager, then re-run --grant-permissions to confirm."),
    }
}

/// Prints the current per-permission state and returns whether everything
/// required is granted (`None` if the response shape was unrecognized).
async fn report_permissions(driver: &Arc<Driver>) -> Option<bool> {
    match driver.call("desktop_permissions", serde_json::json!({})).await {
        Ok(value) => {
            if let Some(data) = value.get("structuredContent").and_then(|v| v.get("data")).and_then(serde_json::Value::as_object) {
                for (name, entry) in data {
                    let state = entry.get("state").and_then(serde_json::Value::as_str).unwrap_or("unknown");
                    println!("[info]   {name}: {state}");
                }
            } else {
                println!("[info] Current permission state: {value}");
            }
            all_permissions_granted(&value)
        }
        Err(cause) => { println!("[warn] Could not read current permission state: {cause}"); None }
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
    let desktop_ready = driver.call("desktop_list_apps", serde_json::json!({})).await.is_ok();
    // Local tools are advertised only when `--shell` was actually passed:
    // the server gates every local_* call on seeing them here, so a companion
    // restarted without the flag loses that surface immediately.
    let mut safe_tools = tools::SAFE_COMMANDS.to_vec();
    if args.local_shell {
        safe_tools.extend_from_slice(local::LOCAL_TOOLS);
    }
    let schema_supported = desktop_ready || args.local_shell;
    let readiness = Readiness {
        driver_version: None,
        schema_supported,
        daemon: if desktop_ready { "running" } else { "unknown" },
        safe_tools,
        device_name: args.device_name.clone(),
        os: os_label(),
    };
    let state = match (desktop_ready, args.local_shell) {
        (true, true) => "agent-desktop ready, local shell enabled",
        (true, false) => "agent-desktop ready",
        (false, true) => "local shell enabled - agent-desktop not available, desktop tool calls will fail",
        (false, false) => "agent-desktop not available - tool calls will fail",
    };
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
