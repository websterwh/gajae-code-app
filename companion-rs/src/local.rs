//! `--shell`: opt-in shell and filesystem access for the paired app.
//!
//! The companion's whole reason to exist is a narrow, reviewed desktop-driving
//! surface. This module is the one deliberate exception, and it is only reachable
//! when the person starting the companion asked for it on the command line with
//! `--shell`. Without that flag `main.rs` refuses every `local_*` request
//! before it reaches this code, and `--help` says so.
//!
//! The intent is parity with running the GJC CLI on this machine: the agent gets
//! a shell, file reads and writes, a listing, and a search - not a general RPC
//! tunnel. Every tool is bounded (command length, write size, output size,
//! timeout, walk depth and result count) so one call cannot hang the companion
//! or return an unbounded blob.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

pub const LOCAL_TOOLS: &[&str] = &[
    "local_exec",
    "local_list_files",
    "local_read_file",
    "local_search",
    "local_write_file",
];

const MAX_COMMAND_BYTES: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_PATTERN_BYTES: usize = 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 100_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_MAX_RESULTS: usize = 200;
const MAX_MAX_RESULTS: usize = 1000;
const MAX_WALK_ENTRIES: usize = 20_000;
const MAX_WALK_DEPTH: usize = 12;

pub fn is_local_tool(name: &str) -> bool {
    LOCAL_TOOLS.contains(&name)
}

pub async fn call(tool: &str, args: &Value) -> Result<Value, String> {
    match tool {
        "local_exec" => exec(args).await,
        "local_list_files" => blocking(tool, args, list_files).await,
        "local_read_file" => blocking(tool, args, read_file).await,
        "local_search" => blocking(tool, args, search).await,
        "local_write_file" => blocking(tool, args, write_file).await,
        other => Err(format!("{other} is not a local tool")),
    }
}

/// File tools are synchronous std::fs work; running them off the runtime keeps
/// a slow recursive search from stalling the websocket loop.
async fn blocking(
    tool: &str,
    args: &Value,
    handler: fn(&str, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let tool = tool.to_string();
    let args = args.clone();
    tokio::task::spawn_blocking(move || handler(&tool, &args))
        .await
        .map_err(|cause| format!("local tool failed: {cause}"))?
}

fn truncate(value: &str) -> String {
    if value.chars().count() <= MAX_OUTPUT_CHARS {
        return value.to_string();
    }
    let kept: String = value.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{kept}\n… output truncated at {MAX_OUTPUT_CHARS} characters")
}

fn required_string(args: &Value, tool: &str, name: &str, max_bytes: usize) -> Result<String, String> {
    let value = args.get(name).and_then(Value::as_str).unwrap_or("");
    if value.is_empty() {
        return Err(format!("{tool} requires \"{name}\"."));
    }
    if value.len() > max_bytes {
        return Err(format!("{tool} argument \"{name}\" exceeds {max_bytes} bytes."));
    }
    if value.contains('\0') {
        return Err(format!("{tool} argument \"{name}\" contains a NUL byte."));
    }
    Ok(value.to_string())
}

fn optional_string(args: &Value, tool: &str, name: &str, max_bytes: usize) -> Result<Option<String>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            if value.len() > max_bytes {
                return Err(format!("{tool} argument \"{name}\" exceeds {max_bytes} bytes."));
            }
            if value.contains('\0') {
                return Err(format!("{tool} argument \"{name}\" contains a NUL byte."));
            }
            Ok(if value.is_empty() { None } else { Some(value.clone()) })
        }
        Some(_) => Err(format!("{tool} argument \"{name}\" must be a string.")),
    }
}

fn optional_u64(args: &Value, tool: &str, name: &str) -> Result<Option<u64>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{tool} argument \"{name}\" must be a non-negative integer.")),
    }
}

fn max_results(args: &Value, tool: &str) -> Result<usize, String> {
    let requested = optional_u64(args, tool, "max_results")?.unwrap_or(DEFAULT_MAX_RESULTS as u64) as usize;
    Ok(requested.clamp(1, MAX_MAX_RESULTS))
}

async fn exec(args: &Value) -> Result<Value, String> {
    let command = required_string(args, "local_exec", "command", MAX_COMMAND_BYTES)?;
    let cwd = optional_string(args, "local_exec", "cwd", MAX_PATH_BYTES)?;
    let timeout_ms = optional_u64(args, "local_exec", "timeout_ms")?
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);

    let mut process = if cfg!(windows) {
        let mut command_process = tokio::process::Command::new("cmd");
        command_process.arg("/C").arg(&command);
        command_process
    } else {
        let mut shell_process = tokio::process::Command::new("/bin/sh");
        shell_process.arg("-c").arg(&command);
        shell_process
    };
    if let Some(directory) = &cwd {
        process.current_dir(directory);
    }
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = process
        .spawn()
        .map_err(|cause| format!("failed to start the command: {cause}"))?;
    let output = match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(cause)) => return Err(format!("command failed: {cause}")),
        Err(_) => {
            return Err(format!(
                "command timed out after {timeout_ms} ms and was killed. Re-run it with nohup/& if it is a long-lived process, or pass a larger timeout_ms."
            ))
        }
    };
    Ok(json!({
        "exit_code": output.status.code(),
        "stdout": truncate(&String::from_utf8_lossy(&output.stdout)),
        "stderr": truncate(&String::from_utf8_lossy(&output.stderr)),
    }))
}

fn read_file(tool: &str, args: &Value) -> Result<Value, String> {
    let path = required_string(args, tool, "path", MAX_PATH_BYTES)?;
    let offset = optional_u64(args, tool, "offset")?.unwrap_or(1).max(1) as usize;
    let limit = optional_u64(args, tool, "limit")?.unwrap_or(2000).clamp(1, 5000) as usize;

    let metadata = std::fs::metadata(&path).map_err(|cause| format!("cannot read {path}: {cause}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} is a directory; use local_list_files instead."));
    }
    let bytes = std::fs::read(&path).map_err(|cause| format!("cannot read {path}: {cause}"))?;
    let file_truncated = bytes.len() > MAX_READ_BYTES;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_READ_BYTES)]).to_string();
    let lines: Vec<&str> = text.lines().collect();
    let start = offset.saturating_sub(1).min(lines.len());
    let end = start.saturating_add(limit).min(lines.len());
    Ok(json!({
        "path": path,
        "offset": offset,
        "lines": end - start,
        "total_lines": lines.len(),
        "truncated": end < lines.len() || file_truncated,
        "file_truncated": file_truncated,
        "content": truncate(&lines[start..end].join("\n")),
    }))
}

fn write_file(tool: &str, args: &Value) -> Result<Value, String> {
    let path = required_string(args, tool, "path", MAX_PATH_BYTES)?;
    let content = args.get("content").and_then(Value::as_str)
        .ok_or_else(|| format!("{tool} requires \"content\"."))?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("{tool} argument \"content\" exceeds {MAX_WRITE_BYTES} bytes."));
    }
    let create_dirs = args.get("create_dirs").and_then(Value::as_bool).unwrap_or(true);
    let target = PathBuf::from(&path);
    if create_dirs {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|cause| format!("cannot create {}: {cause}", parent.display()))?;
            }
        }
    }
    std::fs::write(&target, content.as_bytes()).map_err(|cause| format!("cannot write {path}: {cause}"))?;
    Ok(json!({ "path": path, "bytes_written": content.len() }))
}

fn list_files(tool: &str, args: &Value) -> Result<Value, String> {
    let path = required_string(args, tool, "path", MAX_PATH_BYTES)?;
    let pattern = optional_string(args, tool, "pattern", MAX_PATTERN_BYTES)?;
    let limit = max_results(args, tool)?;
    let entries = std::fs::read_dir(&path).map_err(|cause| format!("cannot list {path}: {cause}"))?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(pattern) = &pattern {
            if !glob_match(pattern, &name) {
                continue;
            }
        }
        let Ok(file_type) = entry.file_type() else { continue };
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        files.push(json!({
            "name": name,
            "path": entry.path().display().to_string(),
            "type": if file_type.is_dir() { "dir" } else if file_type.is_file() { "file" } else { "other" },
            "size": size,
        }));
    }
    files.sort_by(|left, right| {
        left.get("name").and_then(Value::as_str).unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    let truncated = files.len() > limit;
    files.truncate(limit);
    Ok(json!({ "path": path, "entries": files, "truncated": truncated }))
}

fn search(tool: &str, args: &Value) -> Result<Value, String> {
    let path = required_string(args, tool, "path", MAX_PATH_BYTES)?;
    let pattern = required_string(args, tool, "pattern", MAX_PATTERN_BYTES)?;
    let case_sensitive = args.get("case_sensitive").and_then(Value::as_bool).unwrap_or(false);
    let limit = max_results(args, tool)?;
    let needle = if case_sensitive { pattern.clone() } else { pattern.to_lowercase() };

    let mut matches = Vec::new();
    let mut visited = 0usize;
    let mut stack = vec![(PathBuf::from(&path), 0usize)];
    'walk: while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_WALK_ENTRIES {
                break 'walk;
            }
            let Ok(file_type) = entry.file_type() else { continue };
            let entry_path = entry.path();
            if file_type.is_dir() {
                if entry.file_name() == ".git" {
                    continue;
                }
                stack.push((entry_path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if entry.metadata().map(|metadata| metadata.len()).unwrap_or(0) > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&entry_path) else { continue };
            if bytes.contains(&0) {
                continue; // binary file
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                let haystack = if case_sensitive { line.to_string() } else { line.to_lowercase() };
                if !haystack.contains(&needle) {
                    continue;
                }
                matches.push(json!({
                    "path": entry_path.display().to_string(),
                    "line": index + 1,
                    "text": truncate(line.trim_end()),
                }));
                if matches.len() >= limit {
                    break 'walk;
                }
            }
        }
    }
    Ok(json!({ "matches": matches, "truncated": matches.len() >= limit, "entries_visited": visited }))
}

/// `*` and `?` wildcards over a single file name; enough for `*.md`-style
/// filtering without pulling in a glob dependency.
fn glob_match(pattern: &str, name: &str) -> bool {
    fn walk(pattern: &[char], name: &[char]) -> bool {
        match pattern.first() {
            None => name.is_empty(),
            Some('*') => walk(&pattern[1..], name) || (!name.is_empty() && walk(pattern, &name[1..])),
            Some('?') => !name.is_empty() && walk(&pattern[1..], &name[1..]),
            Some(expected) => name.first() == Some(expected) && walk(&pattern[1..], &name[1..]),
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    walk(&pattern, &name)
}
