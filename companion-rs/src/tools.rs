//! Companion-side allowlist for agent-desktop commands.
//!
//! Mirrors the server's authoritative policy (`agent-desktop-capability.ts`,
//! the port of `cua-capability.ts`): the companion enforces its own copy so
//! a compromised or buggy server cannot make it run arbitrary commands, but
//! the server remains the source of truth for what is actually safe.
//!
//! Names here are the real MCP tool names `agent-desktop mcp` advertises via
//! `tools/list` (confirmed live: `desktop_<command, hyphens -> underscores>`,
//! e.g. CLI `list-apps` -> MCP `desktop_list_apps`), NOT the CLI command
//! names used in agent-desktop's own docs.
//!
//! Scoped deliberately narrower than all 60 commands. Excluded for now:
//! - `desktop_drag`, `desktop_hover`, `desktop_mouse_*`, `desktop_key_down`,
//!   `desktop_key_up`: require `--headed` (real physical input/focus theft)
//!   or are reserved/fail-closed upstream.
//! - notifications/sessions/skills/trace management, `desktop_launch` with
//!   force-kill semantics: broader host impact than the matching CUA
//!   safe-tool set had; add deliberately, not by default, mirroring the
//!   "no shell/filesystem/generic forwarding" charter.
pub const SAFE_COMMANDS: &[&str] = &[
    // App and window
    "desktop_launch", "desktop_list_apps", "desktop_list_windows", "desktop_focus_window",
    "desktop_resize_window", "desktop_move_window", "desktop_minimize", "desktop_maximize",
    "desktop_restore",
    // Observation
    "desktop_snapshot", "desktop_find", "desktop_get", "desktop_is", "desktop_screenshot",
    "desktop_list_displays", "desktop_list_surfaces",
    // Interaction
    "desktop_click", "desktop_double_click", "desktop_right_click", "desktop_type",
    "desktop_set_value", "desktop_clear", "desktop_focus", "desktop_select", "desktop_toggle",
    "desktop_check", "desktop_uncheck", "desktop_expand", "desktop_collapse",
    // Scroll
    "desktop_scroll", "desktop_scroll_to",
    // Keyboard
    "desktop_press",
];

pub fn is_safe_command(command: &str) -> bool {
    SAFE_COMMANDS.contains(&command)
}
