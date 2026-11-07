import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentDesktopPolicyError,
  agentDesktopToolPolicy,
  guardAgentDesktopCall,
  isAgentDesktopDiscoveryTool,
  isWellFormedRefId,
  requiresApplicationIdentity,
  snapshotIdFromRef,
  AGENT_DESKTOP_SCHEMA_VERSION,
} from './agent-desktop-capability.js';

const DENIED = { name: 'AgentDesktopPolicyError' };

function denies(tool: string, args: Record<string, unknown>, match?: RegExp): void {
  assert.throws(() => guardAgentDesktopCall(tool, args), match ? { ...DENIED, message: match } : DENIED);
}

function allows(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return guardAgentDesktopCall(tool, args).arguments;
}

test('schema version pins to the live agent-desktop release these policies were captured from', () => {
  assert.equal(AGENT_DESKTOP_SCHEMA_VERSION, '1.2.0');
});

/* -------------------------------------------------------------------------- */
/* Ref addressing                                                             */
/* -------------------------------------------------------------------------- */

test('a well-formed ref_id matches the documented @<snapshot_id>:e<N> shape', () => {
  assert.equal(isWellFormedRefId('@s8f3k2p9:e3'), true);
  assert.equal(isWellFormedRefId('@s1vylk49fulgx4:e0'), true);
});

test('a bare @eN ref is rejected, matching the driver\'s own documented refusal', () => {
  assert.equal(isWellFormedRefId('@e1'), false);
  assert.equal(isWellFormedRefId('e1'), false);
  assert.equal(isWellFormedRefId(''), false);
  assert.equal(isWellFormedRefId(42), false);
  assert.equal(isWellFormedRefId(undefined), false);
});

test('snapshotIdFromRef recovers the owning snapshot namespace', () => {
  assert.equal(snapshotIdFromRef('@s8f3k2p9:e3'), 's8f3k2p9');
  assert.equal(snapshotIdFromRef('@eN'), undefined);
});

/* -------------------------------------------------------------------------- */
/* Interaction tools (ref-addressed) - schemas captured live from tools/list   */
/* -------------------------------------------------------------------------- */

test('click accepts exactly its documented fields', () => {
  assert.deepEqual(allows('desktop_click', { ref_id: '@s8f3k2p9:e3' }), { ref_id: '@s8f3k2p9:e3' });
  assert.deepEqual(
    allows('desktop_click', { ref_id: '@s8f3k2p9:e3', timeout_ms: 2000 }),
    { ref_id: '@s8f3k2p9:e3', timeout_ms: 2000 },
  );
});

test('click requires ref_id and rejects a malformed one', () => {
  denies('desktop_click', {}, /requires "ref_id"/u);
  denies('desktop_click', { ref_id: '@eN' }, /ref_id does not match/u);
  denies('desktop_click', { ref_id: 'e3' }, /ref_id does not match/u);
});

test('an unknown argument is rejected, mirroring the driver\'s additionalProperties: false', () => {
  denies('desktop_click', { ref_id: '@s8f3k2p9:e3', pid: 42 }, /does not document an argument named "pid"/u);
});

test('an unknown tool is rejected', () => {
  denies('desktop_shell_exec', {}, /unknown tool/u);
});

test('type accepts text and interval_ms alongside ref_id', () => {
  assert.deepEqual(
    allows('desktop_type', { ref_id: '@s8f3k2p9:e3', text: 'hello', interval_ms: 50 }),
    { ref_id: '@s8f3k2p9:e3', text: 'hello', interval_ms: 50 },
  );
});

test('select requires both ref_id and value (not "option")', () => {
  denies('desktop_select', { ref_id: '@s8f3k2p9:e3' }, /requires "value"/u);
  assert.deepEqual(
    allows('desktop_select', { ref_id: '@s8f3k2p9:e3', value: 'Option A' }),
    { ref_id: '@s8f3k2p9:e3', value: 'Option A' },
  );
});

test('get and is use "property", not "state"', () => {
  assert.deepEqual(allows('desktop_get', { ref_id: '@s8f3k2p9:e3', property: 'text' }),
    { ref_id: '@s8f3k2p9:e3', property: 'text' });
  assert.deepEqual(allows('desktop_is', { ref_id: '@s8f3k2p9:e3', property: 'visible' }),
    { ref_id: '@s8f3k2p9:e3', property: 'visible' });
  denies('desktop_get', { ref_id: '@s8f3k2p9:e3', state: 'text' }, /does not document an argument named "state"/u);
});

/* -------------------------------------------------------------------------- */
/* Mouse tools use a single "xy" string, not separate x/y integers            */
/* -------------------------------------------------------------------------- */

test('mouse-move requires xy and rejects separate x/y fields', () => {
  assert.deepEqual(allows('desktop_mouse_move', { xy: '100,200' }), { xy: '100,200' });
  denies('desktop_mouse_move', { x: 100, y: 200 }, /does not document an argument named "x"/u);
  denies('desktop_mouse_move', {}, /requires "xy"/u);
});

test('drag uses from/from_xy/to/to_xy, not from_ref_id/to_ref_id', () => {
  assert.deepEqual(
    allows('desktop_drag', { from: '@s1:e1', to: '@s1:e2', duration: 300 }),
    { from: '@s1:e1', to: '@s1:e2', duration: 300 },
  );
  assert.deepEqual(allows('desktop_drag', { from_xy: '10,20', to_xy: '80,20' }), { from_xy: '10,20', to_xy: '80,20' });
});

/* -------------------------------------------------------------------------- */
/* Batch, notifications, clipboard - verified field names                     */
/* -------------------------------------------------------------------------- */

test('batch uses commands_json (a JSON string), not a commands array', () => {
  const commandsJson = JSON.stringify([{ command: 'click', args: { ref_id: '@s1:e1' } }]);
  assert.deepEqual(allows('desktop_batch', { commands_json: commandsJson }), { commands_json: commandsJson });
  denies('desktop_batch', { commands: [] }, /does not document an argument named "commands"/u);
});

test('notification tools address by index, not id', () => {
  assert.deepEqual(allows('desktop_dismiss_notification', { index: 0 }), { index: 0 });
  denies('desktop_dismiss_notification', { id: 'abc' }, /does not document an argument named "id"/u);
  assert.deepEqual(
    allows('desktop_notification_action', { index: 0, action: 'Open' }),
    { index: 0, action: 'Open' },
  );
});

test('clipboard-set accepts text, image, or file_url', () => {
  assert.deepEqual(allows('desktop_clipboard_set', { text: 'hi' }), { text: 'hi' });
  assert.deepEqual(allows('desktop_clipboard_set', { file_url: ['/tmp/a.png'] }), { file_url: ['/tmp/a.png'] });
});

test('trace-export uses "out", not "path"', () => {
  assert.deepEqual(allows('desktop_trace_export', { out: '/tmp/trace.json' }), { out: '/tmp/trace.json' });
  denies('desktop_trace_export', { path: '/tmp/trace.json' }, /does not document an argument named "path"/u);
});

/* -------------------------------------------------------------------------- */
/* Required fields and types                                                  */
/* -------------------------------------------------------------------------- */

test('launch requires app', () => {
  denies('desktop_launch', {}, /requires "app"/u);
  assert.deepEqual(allows('desktop_launch', { app: 'TextEdit', activate: true }), { app: 'TextEdit', activate: true });
});

test('close_app requires app', () => {
  denies('desktop_close_app', {}, /requires "app"/u);
  assert.deepEqual(allows('desktop_close_app', { app: 'TextEdit', force: true }), { app: 'TextEdit', force: true });
});

test('a field with the wrong declared type is rejected', () => {
  denies('desktop_click', { ref_id: '@s8f3k2p9:e3', timeout_ms: 'fast' }, /does not match its documented type/u);
  denies('desktop_close_app', { app: 'TextEdit', force: 'yes' }, /does not match its documented type/u);
});

/* -------------------------------------------------------------------------- */
/* Discovery / application-identity                                           */
/* -------------------------------------------------------------------------- */

test('read-only observation tools are discovery tools', () => {
  assert.equal(isAgentDesktopDiscoveryTool('desktop_list_apps'), true);
  assert.equal(isAgentDesktopDiscoveryTool('desktop_snapshot'), true);
  assert.equal(isAgentDesktopDiscoveryTool('desktop_find'), true);
  assert.equal(isAgentDesktopDiscoveryTool('desktop_click'), false);
  assert.equal(isAgentDesktopDiscoveryTool('desktop_launch'), false);
});

test('application identity is required once a call names an app, window, or ref', () => {
  assert.equal(requiresApplicationIdentity('desktop_list_apps', {}), false);
  assert.equal(requiresApplicationIdentity('desktop_launch', {}), true);
  assert.equal(requiresApplicationIdentity('desktop_close_app', { app: 'TextEdit' }), true);
  assert.equal(requiresApplicationIdentity('desktop_click', { ref_id: '@s1:e1' }), true);
  assert.equal(requiresApplicationIdentity('desktop_list_windows', { app: 'TextEdit' }), true);
  assert.equal(requiresApplicationIdentity('desktop_list_windows', {}), false);
});

test('policy denials are typed so callers can distinguish them from driver failures', () => {
  assert.throws(() => guardAgentDesktopCall('desktop_click', {}), (error: unknown) => {
    assert.ok(error instanceof AgentDesktopPolicyError);
    assert.match((error as Error).message, /^agent_desktop_policy_denied: /u);
    return true;
  });
});

test('every policy entry is reachable by name', () => {
  for (const tool of [
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
  ]) {
    assert.ok(agentDesktopToolPolicy(tool), `missing policy for ${tool}`);
  }
});
