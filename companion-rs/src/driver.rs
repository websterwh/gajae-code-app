//! Subprocess client for `agent-desktop mcp`.
//!
//! Mirrors `cua-companion.mjs`'s `driver` object: spawn once, speak MCP
//! JSON-RPC over the child's stdin/stdout, perform the `initialize` ->
//! `notifications/initialized` handshake before any `tools/call` (required -
//! this was the exact bug fixed in the CUA companion: calling `tools/call`
//! before completing the handshake fails with "Missing required per-request
//! MCP metadata"), and auto-respawn the child if it has exited instead of
//! staying permanently poisoned by one crash.

use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub struct Driver {
    executable: String,
    inner: Mutex<Option<Running>>,
    next_id: AtomicI64,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

impl Driver {
    pub fn new(executable: String) -> Self {
        Self { executable, inner: Mutex::new(None), next_id: AtomicI64::new(1) }
    }

    async fn spawn(&self) -> std::io::Result<Running> {
        let mut child = Command::new(&self.executable)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout piped"));
        let mut running = Running { child, stdin, stdout };
        initialize(&mut running).await?;
        Ok(running)
    }

    /// Calls `tool_name` with `arguments`, respawning the child first if it
    /// has exited since the last call (crash-recovery, not permanent
    /// poisoning).
    pub async fn call(&self, tool_name: &str, arguments: Value) -> Result<Value, String> {
        let mut guard = self.inner.lock().await;
        let needs_spawn = match guard.as_mut() {
            None => true,
            Some(running) => running.child.try_wait().map(|status| status.is_some()).unwrap_or(true),
        };
        if needs_spawn {
            let running = self.spawn().await.map_err(|cause| format!("failed to start agent-desktop: {cause}"))?;
            *guard = Some(running);
        }
        let running = guard.as_mut().expect("just spawned or already present");
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool_name, "arguments": arguments },
        });
        send(running, &request).await.map_err(|cause| cause.to_string())?;
        let response = recv_matching(running, id).await.map_err(|cause| cause.to_string())?;
        if let Some(error) = response.get("error") {
            return Err(error.get("message").and_then(Value::as_str).unwrap_or("agent-desktop error").to_string());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn close(&self) {
        if let Some(mut running) = self.inner.lock().await.take() {
            let _ = running.child.kill().await;
        }
    }
}

async fn initialize(running: &mut Running) -> std::io::Result<()> {
    let init = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "gajae-agent-desktop-companion", "version": "0.1.0" },
        },
    });
    send(running, &init).await?;
    recv_matching(running, 0).await?;
    let notify = json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} });
    send(running, &notify).await?;
    Ok(())
}

async fn send(running: &mut Running, message: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_string(message).expect("serializable");
    line.push('\n');
    running.stdin.write_all(line.as_bytes()).await?;
    running.stdin.flush().await
}

/// Reads lines until one with the matching `id` arrives. Notifications and
/// out-of-order responses (agent-desktop's MCP server is single-request at a
/// time per our usage, but this stays robust if that changes) are skipped.
async fn recv_matching(running: &mut Running, id: i64) -> std::io::Result<Value> {
    loop {
        let mut line = String::new();
        let bytes = running.stdout.read_line(&mut line).await?;
        if bytes == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "agent-desktop exited"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else { continue };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(value);
        }
    }
}
