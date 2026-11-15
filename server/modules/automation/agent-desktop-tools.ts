/**
 * The reviewed subset of agent-desktop's `desktop_*` MCP tools.
 *
 * This list is policy data, not a transport: it is used to accept a tool name
 * from a paired companion and to reject anything outside the reviewed surface.
 */
export const AGENT_DESKTOP_SAFE_TOOLS = [
  'desktop_batch', 'desktop_check', 'desktop_clear', 'desktop_click', 'desktop_clipboard_clear',
  'desktop_clipboard_get', 'desktop_clipboard_set', 'desktop_close_app', 'desktop_collapse',
  'desktop_cursor_overlay_disable', 'desktop_cursor_overlay_enable', 'desktop_dismiss_all_notifications',
  'desktop_dismiss_notification', 'desktop_double_click', 'desktop_drag', 'desktop_expand', 'desktop_find',
  'desktop_focus', 'desktop_focus_window', 'desktop_get', 'desktop_hover', 'desktop_is', 'desktop_key_down',
  'desktop_key_up', 'desktop_launch', 'desktop_list_apps', 'desktop_list_displays',
  'desktop_list_notifications', 'desktop_list_surfaces', 'desktop_list_windows', 'desktop_maximize',
  'desktop_minimize', 'desktop_mouse_click', 'desktop_mouse_down', 'desktop_mouse_move', 'desktop_mouse_up',
  'desktop_mouse_wheel', 'desktop_move_window', 'desktop_notification_action', 'desktop_open_system_surface',
  'desktop_permissions', 'desktop_press', 'desktop_resize_window', 'desktop_restore', 'desktop_right_click',
  'desktop_screenshot', 'desktop_scroll', 'desktop_scroll_to', 'desktop_select', 'desktop_session_end',
  'desktop_session_gc', 'desktop_session_list', 'desktop_session_start', 'desktop_set_value',
  'desktop_skills_get', 'desktop_skills_list', 'desktop_skills_path', 'desktop_snapshot', 'desktop_status',
  'desktop_toggle', 'desktop_trace_export', 'desktop_trace_show', 'desktop_triple_click', 'desktop_type',
  'desktop_uncheck', 'desktop_version', 'desktop_wait',
] as const;

export type AgentDesktopSafeTool = (typeof AGENT_DESKTOP_SAFE_TOOLS)[number];

export type AgentDesktopStatus = {
  installed: boolean;
  version?: string;
  daemon: 'running' | 'stopped' | 'unknown';
  schemaSupported?: boolean;
  error?: string;
};

export function isAgentDesktopSafeTool(value: unknown): value is AgentDesktopSafeTool {
  return typeof value === 'string' && (AGENT_DESKTOP_SAFE_TOOLS as readonly string[]).includes(value);
}
