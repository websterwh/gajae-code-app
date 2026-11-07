//! Companion-side allowlist for agent-desktop commands.
//!
//! Mirrors the server's authoritative policy (`agent-desktop-capability.ts`,
//! the port of `cua-capability.ts`): the companion enforces its own copy so
//! a compromised or buggy server cannot make it run arbitrary commands, but
//! the server remains the source of truth for what is actually safe.
//!
//! Names here are the real MCP tool names `agent-desktop mcp` advertises via
//! `tools/list` (confirmed live against agent-desktop 1.2.0: `desktop_*`,
//! NOT the CLI command names used in agent-desktop's own docs - e.g. CLI
//! `list-apps` is MCP `desktop_list_apps`).
//!
//! Per explicit instruction, this exposes the full live tool surface (67
//! tools as of 1.2.0, covering all 60 documented CLI commands plus batch,
//! clipboard, cursor-overlay, notifications, permissions, session, skills,
//! trace, and version/status/wait helpers) rather than the earlier
//! conservative CUA-parity subset. `--headed` semantics (physical
//! input/focus theft for drag/hover/mouse-*/key-down/key-up) are still
//! gated by agent-desktop itself, not by this allowlist.
pub const SAFE_COMMANDS: &[&str] = &[
    "desktop_batch",
    "desktop_check",
    "desktop_clear",
    "desktop_click",
    "desktop_clipboard_clear",
    "desktop_clipboard_get",
    "desktop_clipboard_set",
    "desktop_close_app",
    "desktop_collapse",
    "desktop_cursor_overlay_disable",
    "desktop_cursor_overlay_enable",
    "desktop_dismiss_all_notifications",
    "desktop_dismiss_notification",
    "desktop_double_click",
    "desktop_drag",
    "desktop_expand",
    "desktop_find",
    "desktop_focus",
    "desktop_focus_window",
    "desktop_get",
    "desktop_hover",
    "desktop_is",
    "desktop_key_down",
    "desktop_key_up",
    "desktop_launch",
    "desktop_list_apps",
    "desktop_list_displays",
    "desktop_list_notifications",
    "desktop_list_surfaces",
    "desktop_list_windows",
    "desktop_maximize",
    "desktop_minimize",
    "desktop_mouse_click",
    "desktop_mouse_down",
    "desktop_mouse_move",
    "desktop_mouse_up",
    "desktop_mouse_wheel",
    "desktop_move_window",
    "desktop_notification_action",
    "desktop_open_system_surface",
    "desktop_permissions",
    "desktop_press",
    "desktop_resize_window",
    "desktop_restore",
    "desktop_right_click",
    "desktop_screenshot",
    "desktop_scroll",
    "desktop_scroll_to",
    "desktop_select",
    "desktop_session_end",
    "desktop_session_gc",
    "desktop_session_list",
    "desktop_session_start",
    "desktop_set_value",
    "desktop_skills_get",
    "desktop_skills_list",
    "desktop_skills_path",
    "desktop_snapshot",
    "desktop_status",
    "desktop_toggle",
    "desktop_trace_export",
    "desktop_trace_show",
    "desktop_triple_click",
    "desktop_type",
    "desktop_uncheck",
    "desktop_version",
    "desktop_wait",
];

pub fn is_safe_command(command: &str) -> bool {
    SAFE_COMMANDS.contains(&command)
}
