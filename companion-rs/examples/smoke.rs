//! Throwaway smoke test: exercises the real `agent-desktop mcp` subprocess
//! handshake and a `tools/call` round trip against this machine's live
//! desktop, without needing a WebSocket server. Not part of the shipped
//! binary; run with `cargo run --example smoke`.
#[path = "../src/driver.rs"]
mod driver_mod;

#[tokio::main]
async fn main() {
    let driver = driver_mod::Driver::new("agent-desktop".to_string());
    let result = driver.call("desktop_version", serde_json::json!({})).await;
    println!("{result:?}");
}
