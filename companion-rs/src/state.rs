//! Pairing credential persistence. Mirrors `cua-companion.mjs`'s
//! `loadState`/`saveState`: a small JSON file under the user's config dir,
//! holding the device ID and credential issued once pairing succeeds so
//! later runs reconnect without the one-time pairing token.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceState {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub credential: String,
}

pub fn default_state_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gajae-agent-desktop-companion")
        .join("device.json")
}

pub async fn load(path: &PathBuf) -> Option<DeviceState> {
    let contents = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&contents).ok()
}

pub async fn save(path: &PathBuf, state: &DeviceState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let contents = serde_json::to_string_pretty(state).expect("serializable");
    tokio::fs::write(path, contents).await
}
