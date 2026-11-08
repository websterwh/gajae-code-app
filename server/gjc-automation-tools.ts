import { randomUUID } from 'node:crypto';
import net from 'node:net';

import type { AutomationTools } from '@gajae-code/coding-agent/sdk/session';
import type { ExtensionUIContext } from '@gajae-code/coding-agent/extensibility/extensions/types';
import * as z from 'zod/v4';

import type { GjcPermissionMode } from './gjc-permission-policy.js';

const browserSelector = z.string().min(1).max(4096)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 4096, 'Selector exceeds 4096 UTF-8 bytes.');
const browserActionSchema = z.discriminatedUnion('verb', [
  z.strictObject({ verb: z.literal('navigate'), url: z.string().min(1).max(4096) }),
  z.strictObject({ verb: z.literal('back') }),
  z.strictObject({ verb: z.literal('forward') }),
  z.strictObject({ verb: z.literal('reload') }),
  z.strictObject({ verb: z.literal('observe') }),
  z.strictObject({ verb: z.literal('extract'), selector: browserSelector.optional(), format: z.enum(['text', 'html']).optional() }),
  z.strictObject({ verb: z.literal('click'), selector: browserSelector }),
  z.strictObject({ verb: z.literal('fill'), selector: browserSelector, text: z.string().max(64 * 1024)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 64 * 1024, 'Text exceeds 64 KiB of UTF-8.') }),
]);

const browserSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), url: z.string().min(1).max(4096).optional() }),
  z.strictObject({ action: z.literal('close') }),
  z.strictObject({ action: z.literal('act'), actions: z.array(browserActionSchema).min(1).max(25) }),
]);

// Transport envelope only. `arguments` is intentionally permissive here because
// this schema runs in the worker alongside the model; the authoritative
// per-tool validation is server-side in
// server/modules/automation/agent-desktop-capability.ts (guardAgentDesktopCall).
//
// Tool names are agent-desktop's real MCP tool names (`desktop_*`), verified
// live against a running `agent-desktop mcp` server's `tools/list` response -
// NOT the CLI command names (`click`, `list-apps`) documented on
// agent-desktop's own docs site, which differ (e.g. CLI `list-apps` is MCP
// `desktop_list_apps`). Per explicit instruction this exposes the full live
// 67-tool surface rather than a narrower subset.
const computerSchema = z.object({
  action: z.enum([
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
  ]),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

type BridgeResponse = { id: string; ok: boolean; result?: unknown; error?: string };
type BrowserBinding = { windowEpoch: string; documentEpoch: number; origin: string | null };
type BrowserAuthorization = { granted: boolean; origin: string | null; binding: BrowserBinding | null };
type ComputerAuthorization = { granted: boolean; application: string | null; label: string | null };

export type GjcAutomationBridgeTransport = {
  socketPath: string;
  token: string;
};

const ALLOW_ONCE = 'Allow once';
const ALLOW_ALWAYS = 'Always allow';
const DENY = 'Deny';
const MAX_CUA_TEXT_CHARS = 64 * 1024;
const MAX_CUA_DETAILS_CHARS = 64 * 1024;

export function takeGjcAutomationBridgeTransport(
  environment: NodeJS.ProcessEnv = process.env,
): GjcAutomationBridgeTransport | undefined {
  const socketPath = environment.GJC_AUTOMATION_SOCKET;
  const token = environment.GJC_AUTOMATION_TOKEN;
  delete environment.GJC_AUTOMATION_SOCKET;
  delete environment.GJC_AUTOMATION_TOKEN;
  if (!socketPath || !/^[a-f0-9]{64}$/iu.test(token ?? '')) return undefined;
  return { socketPath, token: token! };
}

function bridgeRequest(
  transport: GjcAutomationBridgeTransport | undefined,
  request: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 310_000,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new Error('Automation request was cancelled.'));
  if (!transport) return Promise.reject(new Error('App automation bridge is unavailable.'));
  const id = `tool-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(transport.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error('Automation request was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeoutMs, () => finish(new Error('Automation request timed out.')));
    socket.on('connect', () => {
      if (settled) return;
      socket.write(`${JSON.stringify({ ...request, id, token: transport.token })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
        if (response.id !== id) throw new Error('Automation bridge returned a mismatched response.');
        if (!response.ok) throw new Error(response.error || 'Automation request failed.');
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Automation response was invalid.'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Automation bridge disconnected.')));
  });
}

export async function closeGjcAutomationSession(
  appSessionId: string,
  transport: GjcAutomationBridgeTransport | undefined,
): Promise<void> {
  await bridgeRequest(transport, {
    surface: 'browser',
    sessionId: appSessionId,
    operation: 'close',
  }, undefined, 5_000);
}

function textResult(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.data === 'string' && typeof record.mimeType === 'string') {
      return {
        content: [{ type: 'image' as const, data: record.data, mimeType: record.mimeType }],
        details: value,
      };
    }
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) ?? 'Done' }],
    details: value,
  };
}

function compactCuaDetails(record: Record<string, unknown>): unknown {
  const structured = record.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  const { elements, tree_markdown: treeMarkdown, ...metadata } = structured as Record<string, unknown>;
  const compact = {
    ...metadata,
    ...((Array.isArray(elements) || typeof treeMarkdown === 'string') ? { omitted: {
      ...(Array.isArray(elements) ? { elements: elements.length } : {}),
      ...(typeof treeMarkdown === 'string' ? { treeMarkdownChars: treeMarkdown.length } : {}),
      reason: 'Large accessibility payload is available to the model through the tool content and was omitted from UI details.',
    } } : {}),
  };
  const serialized = JSON.stringify(compact);
  if (serialized.length <= MAX_CUA_DETAILS_CHARS) return compact;
  return {
    omitted: {
      metadataChars: serialized.length,
      reason: 'Structured metadata exceeded the safe tool-result limit.',
    },
  };
}

function cuaResult(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return textResult(value);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return textResult(value);

  const content: Array<
    { type: 'image'; data: string; mimeType: string }
    | { type: 'text'; text: string }
  > = [];
  for (const block of record.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      const text = item.text.length > MAX_CUA_TEXT_CHARS
        ? `${item.text.slice(0, MAX_CUA_TEXT_CHARS)}\n… ${item.text.length - MAX_CUA_TEXT_CHARS} characters omitted`
        : item.text;
      content.push({ type: 'text', text });
    }
  }
  if (content.length === 0) return textResult(value);
  const details = compactCuaDetails(record);
  if (details) {
    content.push({
      type: 'text',
      text: `CUA structured metadata:\n${JSON.stringify(details, null, 2)}`,
    });
  }
  return { content, details };
}

function browserCommand(action: z.infer<typeof browserActionSchema>): Record<string, unknown> {
  const { verb, ...parameters } = action;
  return { action: verb, ...parameters };
}

function requireBrowserBinding(value: BrowserBinding | null): BrowserBinding {
  if (!value
    || typeof value.windowEpoch !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.windowEpoch)
    || !Number.isSafeInteger(value.documentEpoch) || value.documentEpoch < 0
    || (value.origin !== null && (typeof value.origin !== 'string' || value.origin.length > 4096 || !/^https?:\/\//u.test(value.origin)))) {
    throw new Error('browser_state_unavailable: Open the built-in browser before using browser act.');
  }
  return {
    windowEpoch: value.windowEpoch,
    documentEpoch: value.documentEpoch,
    origin: value.origin,
  };
}

export function createGjcAutomationTools(
  appSessionId: string,
  ui: Pick<ExtensionUIContext, 'select'>,
  transport?: GjcAutomationBridgeTransport,
  permissionMode: GjcPermissionMode = 'ask',
): AutomationTools {
  const ensureBrowserAccess = async (url: string | undefined, signal?: AbortSignal): Promise<BrowserBinding | null> => {
    const check = await bridgeRequest(transport, {
      surface: 'browser',
      sessionId: appSessionId,
      operation: 'authorize',
      payload: { ...(url ? { url } : {}) },
    }, signal) as BrowserAuthorization;
    if (check.granted || !check.origin) return check.binding;

    // The trusted run policy covers this prompt, but must not create grants
    // that survive a later run switching back to Ask (even in this session).
    if (permissionMode === 'bypass') return check.binding;
    const choice = await ui.select(
      `Allow the agent to use ${check.origin}?`,
      [ALLOW_ONCE, ALLOW_ALWAYS, DENY],
      { signal },
    );
    if (choice !== ALLOW_ONCE && choice !== ALLOW_ALWAYS) {
      throw new Error(`Browser access to ${check.origin} was denied.`);
    }
    const granted = await bridgeRequest(transport, {
      surface: 'browser',
      sessionId: appSessionId,
      operation: 'authorize',
      payload: { url: check.origin, scope: choice === ALLOW_ALWAYS ? 'always' : 'session' },
    }, signal) as BrowserAuthorization;
    if (!granted.granted) throw new Error(`Browser access to ${check.origin} was not granted.`);
    // Bind the command to the page that was inspected before permission UI.
    // The person may navigate the WebView while the prompt is pending; using
    // the second authorization response would silently retarget the action.
    return check.binding;
  };

  const browser: NonNullable<AutomationTools['browser']> = {
    name: 'browser',
    label: 'Browser',
    description: 'Control the built-in WebView browser. Open it, observe or extract the current page, then navigate or interact using CSS selectors. The browser persists across calls.',
    parameters: browserSchema as any,
    concurrency: 'exclusive',
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal) {
      const params = browserSchema.parse(rawParams);
      if (params.action === 'open') {
        if (params.url) await ensureBrowserAccess(params.url, signal);
        return textResult(await bridgeRequest(transport, {
          surface: 'browser', sessionId: appSessionId, operation: 'open',
          payload: { ...(params.url ? { url: params.url } : {}) },
        }, signal));
      }
      if (params.action === 'close') {
        return textResult(await bridgeRequest(transport, { surface: 'browser', sessionId: appSessionId, operation: 'close' }, signal));
      }
      const results = [];
      for (const action of params.actions) {
        const expected = requireBrowserBinding(await ensureBrowserAccess(
          action.verb === 'navigate' ? action.url : undefined,
          signal,
        ));
        results.push(await bridgeRequest(transport, {
          surface: 'browser', sessionId: appSessionId, operation: 'command',
          payload: { command: browserCommand(action), expected },
        }, signal));
      }
      return textResult(results.length === 1 ? results[0] : results);
    },
  };

  const ensureComputerAccess = async (
    tool: z.infer<typeof computerSchema>['action'],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> => {
    const check = await bridgeRequest(transport, {
      surface: 'computer',
      sessionId: appSessionId,
      operation: 'authorize',
      tool,
      arguments: args,
    }, signal) as ComputerAuthorization;
    if (check.granted || !check.application) return;

    // `bypass` is a consent-UX mode, not a safety mode. It skips the approval
    // prompt for an otherwise permitted operation, but the server still refuses
    // to dispatch without a materialized application grant, so the grant is
    // created here instead. It is always session-scoped: a trusted run must not
    // silently write a persistent "always" grant on the user's behalf.
    let scope: 'session' | 'always';
    if (permissionMode === 'bypass') {
      scope = 'session';
    } else {
      const choice = await ui.select(
        `Allow the agent to control ${check.label ?? check.application}?`,
        [ALLOW_ONCE, ALLOW_ALWAYS, DENY],
        { signal },
      );
      if (choice !== ALLOW_ONCE && choice !== ALLOW_ALWAYS) {
        throw new Error(`Computer access to ${check.label ?? check.application} was denied.`);
      }
      scope = choice === ALLOW_ALWAYS ? 'always' : 'session';
    }
    const granted = await bridgeRequest(transport, {
      surface: 'computer',
      sessionId: appSessionId,
      operation: 'authorize',
      tool,
      arguments: args,
      payload: { application: check.application, scope },
    }, signal) as ComputerAuthorization;
    if (!granted.granted) throw new Error(`Computer access to ${check.label ?? check.application} was not granted.`);
  };

  const computer: NonNullable<AutomationTools['computer']> = {
    name: 'computer',
    label: 'Computer',
    description: 'Control a reviewed native application through agent-desktop, an accessibility-tree-based desktop automation driver. Workflow: call desktop_snapshot or desktop_find on a window or app to get an accessibility tree with ref_id tokens shaped like "@<snapshot_id>:eN"; then address elements for interaction tools (desktop_click, desktop_type, desktop_set_value, desktop_toggle, desktop_select, desktop_scroll, etc.) using that exact ref_id. A ref_id is only valid within the snapshot that produced it - take a fresh desktop_snapshot or desktop_find after any navigation or layout change before reusing a ref; do not reuse a ref_id from an earlier snapshot. Use desktop_list_apps and desktop_list_windows for discovery, desktop_launch to start or attach to an app, and desktop_get/desktop_is to read element text, value, or state without mutating anything. Verify a mutation worked with a fresh desktop_get, desktop_is, or desktop_snapshot call rather than assuming delivery from a successful response. Browser pages belong in the browser tool, not here. Argument names match agent-desktop exactly: each tool takes its CLI command flags with hyphens as underscores, and positional arguments keep their names - desktop_launch takes app, args, activate, cwd, env and timeout (app is required), desktop_snapshot takes app, window_id, interactive_only, root, max_depth, compact and include_bounds, and the interaction tools take ref_id. Never invent a field name such as app_name. An `agent_desktop_policy_denied: <tool> does not document an argument named "x". Accepted arguments: ...` or `<tool> requires "ref_id"` error means to correct or add that argument and retry, not to give up on this tool.',
    parameters: computerSchema as any,
    concurrency: 'exclusive',
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal) {
      const params = computerSchema.parse(rawParams);
      await ensureComputerAccess(params.action, params.arguments, signal);
      return cuaResult(await bridgeRequest(transport, {
        surface: 'computer', sessionId: appSessionId, tool: params.action, arguments: params.arguments,
      }, signal));
    },
  };

  return { browser, computer };
}
