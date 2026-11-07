//! Wire contract mirror of `app/shared/remote-cua-protocol.ts`.
//!
//! Field names and the `protocolVersion` discriminant are serialized exactly
//! as the TypeScript side expects (camelCase to match the existing server).
//! This protocol is tool-agnostic: `tool`/`arguments` are opaque payloads, so
//! it is unchanged by the CUA Driver -> agent-desktop swap; only the values
//! placed into `tool` and `arguments` differ (see `tools.rs`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct Readiness {
    #[serde(rename = "driverVersion", skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(rename = "schemaSupported")]
    pub schema_supported: bool,
    pub daemon: &'static str,
    #[serde(rename = "safeTools")]
    pub safe_tools: Vec<&'static str>,
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub os: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum Incoming {
    #[serde(rename = "paired")]
    Paired {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "deviceId")]
        device_id: String,
        credential: String,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "pendingApproval", default)]
        pending_approval: bool,
    },
    #[serde(rename = "disconnect")]
    Disconnect {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        reason: String,
    },
    #[serde(rename = "computer.request")]
    ComputerRequest {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "appSessionId")]
        app_session_id: String,
        tool: String,
        arguments: Value,
        deadline: i64,
    },
    #[serde(rename = "cancel")]
    Cancel {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum Outgoing {
    #[serde(rename = "hello")]
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "deviceId", skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(rename = "credential", skip_serializing_if = "Option::is_none")]
        credential: Option<String>,
        #[serde(rename = "pairingToken", skip_serializing_if = "Option::is_none")]
        pairing_token: Option<String>,
        #[serde(rename = "deviceName", skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        os: Option<String>,
    },
    #[serde(rename = "readiness")]
    Readiness {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        readiness: Readiness,
    },
    #[serde(rename = "computer.result")]
    ComputerResult {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}
