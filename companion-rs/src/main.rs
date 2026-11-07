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
}

fn parse_args() -> Args {
    let mut server = String::new();
    let mut pairing_token = None;
    let mut device_name = hostname();
    let mut state_path = state::default_state_path();
    let mut executable = "agent-desktop".to_string();
    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--server=") {
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
    Args { server, pairing_token, device_name, state_path, executable }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-device".to_string())
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
    if args.server.is_empty() {
        eprintln!("[error] --server=wss://host/remote-cua is required.");
        std::process::exit(1);
    }
    if let Err(cause) = normalize_server_url(&args.server) {
        eprintln!("[error] {cause}");
        std::process::exit(1);
    }
    let driver = Arc::new(Driver::new(args.executable.clone()));
    let state = Arc::new(Mutex::new(state::load(&args.state_path).await));

    loop {
        if let Err(cause) = connect_once(&args, &driver, &state).await {
            eprintln!("[info] Disconnected ({cause}). Retrying in 2s...");
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
        return Err(format!("server rejected connection (HTTP {})", response.status()));
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

    while let Some(message) = read.next().await {
        let message = message.map_err(|cause| cause.to_string())?;
        let Message::Text(text) = message else { continue };
        let Ok(incoming) = serde_json::from_str::<Incoming>(&text) else { continue };
        match incoming {
            Incoming::Paired { device_id, credential, .. } => {
                let new_state = state::DeviceState { device_id: device_id.clone(), credential: credential.clone() };
                state::save(&args.state_path, &new_state).await.map_err(|cause| cause.to_string())?;
                *state.lock().await = Some(new_state);
                println!("[info] Paired and connected. This device is now available to the server.");
                send_readiness(&mut write, &device_id, args, driver).await?;
            }
            Incoming::Pong { .. } => {
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

async fn send_readiness(
    write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    device_id: &str,
    args: &Args,
    driver: &Arc<Driver>,
) -> Result<(), String> {
    let _ = device_id;
    // A cheap read-only probe to report driver availability, matching the
    // old companion's readiness ping. `list-apps` is in SAFE_COMMANDS and
    // succeeding proves agent-desktop is installed and can reach a display.
    let schema_supported = driver.call("list-apps", serde_json::json!({})).await.is_ok();
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
