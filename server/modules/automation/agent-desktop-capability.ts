/**
 * Trusted server-side capability boundary for agent-desktop (vercel-labs)
 * 1.2.0, the MCP-exposed `desktop_*` tool surface.
 *
 * Port of `cua-capability.ts`'s role, retargeted to agent-desktop's actual
 * addressing model, which is fundamentally different from CUA Driver's:
 *
 *  - CUA addresses elements by `element_token` bound to a `pid`/`window_id`.
 *  - agent-desktop addresses elements by a snapshot-qualified `ref_id`
 *    (`@<snapshot_id>:e<N>`) returned by a prior `desktop_snapshot` or
 *    `desktop_find` call. A ref is only valid within the snapshot namespace
 *    that produced it (see CONCEPTS.md "Snapshot ID": "an ID created in a
 *    session is not a cross-session handle").
 *
 * Schemas below are transcribed from the live `tools/list` response of
 * agent-desktop 1.2.0 (`additionalProperties: false` on every tool), not
 * guessed from documentation prose, so field names/types are exact.
 *
 * Per explicit instruction this exposes the full 67-tool MCP surface; this
 * module's job is per-tool argument validation (reject anything outside the
 * tool's own documented schema), not narrowing the tool list itself — that
 * allowlist lives in the companion (`companion-rs/src/tools.rs`) and must be
 * kept in sync.
 */

/** agent-desktop release whose published tool schemas this policy was derived from. */
export const AGENT_DESKTOP_SCHEMA_VERSION = '1.2.0';

export class AgentDesktopPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDesktopPolicyError';
  }
}

function deny(reason: string): never {
  throw new AgentDesktopPolicyError(`agent_desktop_policy_denied: ${reason}`);
}

/* -------------------------------------------------------------------------- */
/* Ref addressing                                                             */
/* -------------------------------------------------------------------------- */

/** `@<snapshot_id>:e<N>`, e.g. `@s8f3k2p9:e3`. A bare `@eN` is not accepted. */
const REF_ID_PATTERN = /^@s[0-9a-z]+:e\d+$/u;

export function isWellFormedRefId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && REF_ID_PATTERN.test(value);
}

export function snapshotIdFromRef(refId: string): string | undefined {
  const match = /^@(s[0-9a-z]+):e\d+$/u.exec(refId);
  return match?.[1];
}

/* -------------------------------------------------------------------------- */
/* Per-tool argument policy                                                   */
/* -------------------------------------------------------------------------- */

type FieldType = 'string' | 'integer' | 'boolean' | 'string[]';

type AgentDesktopToolPolicy = {
  /** Field name -> declared type, transcribed from the live inputSchema. */
  fields: Readonly<Record<string, FieldType>>;
  required: readonly string[];
  /** True when this tool addresses an element via `ref_id` (must validate format). */
  refAddressed: boolean;
  /** True when this tool is a read-only discovery/observation call. */
  discovery: boolean;
};

const STRING = 'string' as const;
const INTEGER = 'integer' as const;
const BOOLEAN = 'boolean' as const;
const STRING_ARRAY = 'string[]' as const;

/**
 * Derived from live `tools/list` on agent-desktop 1.2.0. Every tool here
 * mirrors its MCP `inputSchema.properties` keys and types exactly; a field
 * not listed is rejected by `guardAgentDesktopCall`, matching the driver's
 * own `additionalProperties: false`.
 */
const AGENT_DESKTOP_TOOL_POLICIES: Readonly<Record<string, AgentDesktopToolPolicy>> = {
  // ---- App and window --------------------------------------------------
  desktop_launch: {
    fields: { app: STRING, activate: BOOLEAN, args: STRING_ARRAY, cdp: INTEGER, cwd: STRING, env: STRING_ARRAY, no_attach: BOOLEAN, timeout: INTEGER },
    required: ['app'], refAddressed: false, discovery: false,
  },
  desktop_close_app: {
    fields: { app: STRING, force: BOOLEAN },
    required: ['app'], refAddressed: false, discovery: false,
  },
  desktop_list_apps: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_list_windows: {
    fields: { app: STRING, timeout_ms: INTEGER },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_focus_window: {
    fields: { window_id: STRING },
    required: ['window_id'], refAddressed: false, discovery: false,
  },
  desktop_resize_window: {
    fields: { window_id: STRING, width: INTEGER, height: INTEGER },
    required: ['window_id', 'width', 'height'], refAddressed: false, discovery: false,
  },
  desktop_move_window: {
    fields: { window_id: STRING, x: INTEGER, y: INTEGER },
    required: ['window_id', 'x', 'y'], refAddressed: false, discovery: false,
  },
  desktop_minimize: { fields: { window_id: STRING }, required: ['window_id'], refAddressed: false, discovery: false },
  desktop_maximize: { fields: { window_id: STRING }, required: ['window_id'], refAddressed: false, discovery: false },
  desktop_restore: { fields: { window_id: STRING }, required: ['window_id'], refAddressed: false, discovery: false },

  // ---- Observation --------------------------------------------------------
  desktop_snapshot: {
    fields: {
      app: STRING, compact: BOOLEAN, force_electron_a11y: BOOLEAN, include_bounds: BOOLEAN,
      interactive_only: BOOLEAN, max_depth: INTEGER, root: STRING, skeleton: BOOLEAN, surface: STRING,
      timeout_ms: INTEGER, window_id: STRING,
    },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_find: {
    fields: {
      app: STRING, count: BOOLEAN, description: STRING, exact: BOOLEAN, first: BOOLEAN, last: BOOLEAN,
      limit: INTEGER, name: STRING, native_id: STRING, nth: INTEGER, role: STRING, root: STRING,
      states: STRING_ARRAY, surface: STRING, text: STRING, timeout_ms: INTEGER, value: STRING, window_id: STRING,
    },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_get: {
    fields: { ref_id: STRING, property: STRING },
    required: ['ref_id'], refAddressed: true, discovery: true,
  },
  desktop_is: {
    fields: { ref_id: STRING, property: STRING },
    required: ['ref_id'], refAddressed: true, discovery: true,
  },
  desktop_screenshot: {
    fields: { app: STRING, screen: INTEGER, window_id: STRING, output_path: STRING },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_list_displays: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_list_surfaces: {
    fields: { app: STRING },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_open_system_surface: {
    fields: { surface: STRING },
    required: ['surface'], refAddressed: false, discovery: false,
  },

  // ---- Interaction ----------------------------------------------------------
  desktop_click: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_double_click: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_triple_click: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_right_click: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_type: {
    fields: { ref_id: STRING, text: STRING, interval_ms: INTEGER, timeout_ms: INTEGER },
    required: ['ref_id'], refAddressed: true, discovery: false,
  },
  desktop_set_value: {
    fields: { ref_id: STRING, value: STRING, timeout_ms: INTEGER },
    required: ['ref_id'], refAddressed: true, discovery: false,
  },
  desktop_clear: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_focus: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_select: {
    fields: { ref_id: STRING, value: STRING, timeout_ms: INTEGER },
    required: ['ref_id', 'value'], refAddressed: true, discovery: false,
  },
  desktop_toggle: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_check: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_uncheck: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_expand: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },
  desktop_collapse: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },

  // ---- Scroll ---------------------------------------------------------------
  desktop_scroll: {
    fields: { ref_id: STRING, direction: STRING, amount: INTEGER, timeout_ms: INTEGER },
    required: ['ref_id'], refAddressed: true, discovery: false,
  },
  desktop_scroll_to: { fields: { ref_id: STRING, timeout_ms: INTEGER }, required: ['ref_id'], refAddressed: true, discovery: false },

  // ---- Keyboard ---------------------------------------------------------------
  desktop_press: {
    fields: { combo: STRING, app: STRING, window_id: STRING, force: BOOLEAN },
    required: ['combo'], refAddressed: false, discovery: false,
  },
  // Reserved upstream: fail closed instead of holding a key (CONCEPTS.md).
  desktop_key_down: { fields: { combo: STRING, force: BOOLEAN }, required: ['combo'], refAddressed: false, discovery: false },
  desktop_key_up: { fields: { combo: STRING, force: BOOLEAN }, required: ['combo'], refAddressed: false, discovery: false },

  // ---- Mouse (all require --headed upstream; still pass through here) -------
  desktop_hover: {
    fields: { ref_id: STRING, xy: STRING, timeout_ms: INTEGER, duration: INTEGER },
    required: [], refAddressed: true, discovery: false,
  },
  desktop_drag: {
    fields: { from: STRING, from_xy: STRING, to: STRING, to_xy: STRING, duration: INTEGER, drop_delay: INTEGER, timeout_ms: INTEGER, wait_for_scope: STRING },
    required: [], refAddressed: false, discovery: false,
  },
  desktop_mouse_move: { fields: { xy: STRING }, required: ['xy'], refAddressed: false, discovery: false },
  desktop_mouse_down: { fields: { xy: STRING, button: STRING, modifiers: STRING }, required: ['xy'], refAddressed: false, discovery: false },
  desktop_mouse_up: { fields: { xy: STRING, button: STRING, modifiers: STRING }, required: ['xy'], refAddressed: false, discovery: false },
  desktop_mouse_click: { fields: { xy: STRING, button: STRING, count: INTEGER, modifiers: STRING }, required: ['xy'], refAddressed: false, discovery: false },
  desktop_mouse_wheel: { fields: { x: INTEGER, y: INTEGER, dx: INTEGER, dy: INTEGER, modifiers: STRING }, required: [], refAddressed: false, discovery: false },

  // ---- Clipboard --------------------------------------------------------------
  desktop_clipboard_get: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_clipboard_set: {
    fields: { text: STRING, image: STRING, file_url: STRING_ARRAY },
    required: [], refAddressed: false, discovery: false,
  },
  desktop_clipboard_clear: { fields: {}, required: [], refAddressed: false, discovery: false },

  // ---- Cursor overlay -----------------------------------------------------------
  desktop_cursor_overlay_enable: { fields: {}, required: [], refAddressed: false, discovery: false },
  desktop_cursor_overlay_disable: { fields: {}, required: [], refAddressed: false, discovery: false },

  // ---- Notifications ---------------------------------------------------------------
  desktop_list_notifications: {
    fields: { app: STRING, limit: INTEGER, text: STRING },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_dismiss_notification: {
    fields: { app: STRING, expected_app: STRING, expected_title: STRING, index: INTEGER },
    required: ['index'], refAddressed: false, discovery: false,
  },
  desktop_dismiss_all_notifications: { fields: {}, required: [], refAddressed: false, discovery: false },
  desktop_notification_action: {
    fields: { action: STRING, expected_app: STRING, expected_title: STRING, index: INTEGER },
    required: ['index', 'action'], refAddressed: false, discovery: false,
  },

  // ---- Permissions ------------------------------------------------------------------
  desktop_permissions: { fields: { guide: BOOLEAN, request: BOOLEAN }, required: [], refAddressed: false, discovery: true },

  // ---- Sessions ---------------------------------------------------------------------
  desktop_session_start: {
    fields: { cursor: BOOLEAN, multi_agent: BOOLEAN, name: STRING, no_trace: BOOLEAN, screenshots: BOOLEAN },
    required: [], refAddressed: false, discovery: false,
  },
  desktop_session_end: { fields: { id: STRING }, required: [], refAddressed: false, discovery: false },
  desktop_session_list: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_session_gc: { fields: { ended: BOOLEAN, older_than: INTEGER }, required: [], refAddressed: false, discovery: false },

  // ---- Skills ----------------------------------------------------------------------
  desktop_skills_get: {
    fields: { name: STRING, full: BOOLEAN, reference: STRING },
    required: ['name'], refAddressed: false, discovery: true,
  },
  desktop_skills_list: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_skills_path: { fields: {}, required: [], refAddressed: false, discovery: true },

  // ---- Trace -------------------------------------------------------------------------
  desktop_trace_export: { fields: { out: STRING, limit: INTEGER }, required: [], refAddressed: false, discovery: false },
  desktop_trace_show: { fields: {}, required: [], refAddressed: false, discovery: true },

  // ---- Misc --------------------------------------------------------------------------
  desktop_status: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_version: { fields: {}, required: [], refAddressed: false, discovery: true },
  desktop_wait: {
    fields: {
      action: STRING, app: STRING, count: INTEGER, element: STRING, event: STRING, menu: BOOLEAN,
      menu_closed: BOOLEAN, ms: INTEGER, notification: BOOLEAN, predicate: STRING, text: STRING,
      timeout: INTEGER, value: STRING, window: STRING, window_id: STRING,
    },
    required: [], refAddressed: false, discovery: true,
  },
  desktop_batch: {
    fields: { commands_json: STRING, stop_on_error: BOOLEAN, timeout_ms: INTEGER },
    required: ['commands_json'], refAddressed: false, discovery: false,
  },
};

export function agentDesktopToolPolicy(tool: string): AgentDesktopToolPolicy | undefined {
  return Object.hasOwn(AGENT_DESKTOP_TOOL_POLICIES, tool) ? AGENT_DESKTOP_TOOL_POLICIES[tool] : undefined;
}

export type GuardedAgentDesktopCall = { tool: string; arguments: Record<string, unknown> };

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

/**
 * Authoritative per-tool validation. Rejects unknown tools, unknown fields
 * (mirrors the driver's own `additionalProperties: false`), wrong-typed
 * fields, missing required fields, and malformed `ref_id` values. Returns
 * the canonicalized argument record the companion is allowed to receive.
 */
export function guardAgentDesktopCall(tool: string, args: Record<string, unknown>): GuardedAgentDesktopCall {
  const policy = agentDesktopToolPolicy(tool);
  if (!policy) deny(`unknown tool "${tool}".`);

  const guarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const type = policy.fields[key];
    if (!type) deny(`${tool} does not document an argument named "${key}".`);
    if (!matchesType(value, type)) deny(`${tool} argument "${key}" does not match its documented type (${type}).`);
    guarded[key] = value;
  }
  for (const required of policy.required) {
    if (guarded[required] === undefined) deny(`${tool} requires "${required}".`);
  }
  if (policy.refAddressed && guarded.ref_id !== undefined && !isWellFormedRefId(guarded.ref_id)) {
    deny(`${tool} ref_id does not match the documented "@<snapshot_id>:e<N>" format.`);
  }

  return { tool, arguments: guarded };
}

/* -------------------------------------------------------------------------- */
/* Application-identity requirement                                           */
/* -------------------------------------------------------------------------- */

/**
 * Tools that are read-only discovery reads and therefore carry no
 * application-grant requirement, mirroring `isCuaDiscoveryTool`.
 */
export function isAgentDesktopDiscoveryTool(tool: string): boolean {
  return agentDesktopToolPolicy(tool)?.discovery ?? false;
}

/**
 * Whether this exact call must be bound to an approved application before it
 * executes. Unlike CUA's pid-bound model, agent-desktop refs are already
 * scoped to one snapshot (and therefore to whatever window/app owned that
 * snapshot); grant enforcement keys on `app`/`window_id` when present on the
 * call, and on the ref's snapshot provenance otherwise (resolved by the
 * caller via `snapshotIdFromRef`, since the policy layer performs no I/O).
 */
export function requiresApplicationIdentity(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'desktop_launch' || tool === 'desktop_close_app') return true;
  if (typeof args.app === 'string' || typeof args.window_id === 'string') return true;
  if (typeof args.ref_id === 'string') return true;
  return !isAgentDesktopDiscoveryTool(tool);
}
