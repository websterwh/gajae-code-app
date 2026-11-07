import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import readline from 'node:readline';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import {
  AGENT_DESKTOP_SCHEMA_VERSION,
  guardAgentDesktopCall,
} from './agent-desktop-capability.js';

/**
 * Trusted local MCP client for `agent-desktop mcp`, structural port of
 * `cua-client.ts`'s `CuaDriverClient`. Lifecycle, pending-request bookkeeping,
 * and activity accounting are unchanged; only the transport target (CUA
 * Driver -> agent-desktop) and the tool/schema surface (16 CUA safe tools ->
 * 67 live `desktop_*` MCP tools) differ.
 *
 * MCP tool naming note (verified live against agent-desktop 1.2.0): the
 * server's `tools/list` advertises `desktop_<command>` (e.g. `desktop_click`,
 * `desktop_list_apps`), NOT the CLI command names (`click`, `list-apps`)
 * documented on agent-desktop's own docs site. `AGENT_DESKTOP_SAFE_TOOLS`
 * below uses the real MCP names.
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
  /** agent-desktop is stateless-per-call; there is no persistent daemon to report on. */
  daemon: 'running' | 'stopped' | 'unknown';
  schemaSupported?: boolean;
  error?: string;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  tool?: string;
  uncertain?: boolean;
};

type AgentDesktopClientOptions = {
  desktopRestartAdmission?: DesktopWorkAdmission;
};

function mcpServerVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const serverInfo = (value as Record<string, unknown>).serverInfo;
  if (!serverInfo || typeof serverInfo !== 'object' || Array.isArray(serverInfo)) return undefined;
  const version = (serverInfo as Record<string, unknown>).version;
  return typeof version === 'string' ? version : undefined;
}

function executableCandidates(): string[] {
  return [
    process.env.AGENT_DESKTOP_PATH,
    'agent-desktop',
  ].filter((value): value is string => Boolean(value));
}

async function findExecutable(): Promise<string | null> {
  for (const candidate of executableCandidates()) {
    if (candidate.includes('/')) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    } else {
      // Bare command names (the default npm-global install) are resolved by
      // the shell's own PATH lookup at spawn time; probing existence here
      // would require a platform-specific `which`/`where` shim for no real
      // benefit, since spawn() already fails cleanly if it is not found.
      return candidate;
    }
  }
  return null;
}

/** Schema version this policy module was derived from; isCuaDriverSchemaSupported had a
 * minor-version allowlist because CUA ships frequent patch releases with stable schemas.
 * agent-desktop's MCP contract version (`"2.6"` in every envelope, independent of the
 * package's own semver) is the more meaningful compatibility signal; the package semver
 * is reported for operator visibility only. */
export function isAgentDesktopSchemaSupported(version: string | undefined): boolean {
  return typeof version === 'string' && version.length > 0;
}

export class AgentDesktopClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<string | number, Pending>();
  private admission?: DesktopWorkAdmission;
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0;
  private dispatching = 0;
  private inspecting = 0;
  private closing = 0;
  private shuttingDown = false;
  private transportUncertain = false;

  constructor(private readonly options: AgentDesktopClientOptions = {}) {
    this.admission = options.desktopRestartAdmission;
  }

  configureDesktopRestartAdmission(admission?: DesktopWorkAdmission): void {
    this.admission = admission;
    this.activityRevision++;
  }

  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }

  snapshotActivity(): DesktopOwnerActivity {
    const requests = [...this.pending.values()];
    const unknown: string[] = [];
    if (requests.some((request) => request.uncertain)) unknown.push('agent_desktop_request_unconfirmed');
    if (this.transportUncertain) unknown.push('agent_desktop_transport_unconfirmed');
    return {
      owner: 'computer', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: Number(Boolean(this.starting)), queued: this.dispatching,
      running: requests.length + this.inspecting,
      settling: this.closing, approvals: 0, retained: 0, unknown,
    };
  }

  /**
   * `agent-desktop version` runs as a separate short-lived MCP round trip
   * rather than a bare `--version` flag, since the only documented output
   * shape is the JSON envelope (`{"command":"version","data":{...}}`), not a
   * plain version string on stdout.
   */
  async status(): Promise<AgentDesktopStatus> {
    const release = this.admission?.enter('automation.computer.status');
    this.inspecting++;
    this.activityRevision++;
    try {
      const executable = await findExecutable();
      if (!executable) return { installed: false, daemon: 'unknown' };
      try {
        await this.ensureStarted();
        const result = await this.request('tools/call', { name: 'desktop_version', arguments: {} }, 5_000);
        const versionString = envelopeDataField(result, 'version');
        return {
          installed: true,
          version: typeof versionString === 'string' ? versionString : undefined,
          daemon: 'running',
          schemaSupported: true,
        };
      } catch (cause) {
        return {
          installed: true, daemon: 'unknown',
          error: cause instanceof Error ? cause.message : 'Unable to inspect agent-desktop.',
        };
      }
    } finally {
      this.inspecting--;
      this.activityRevision++;
      release?.();
    }
  }

  async call(tool: AgentDesktopSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!AGENT_DESKTOP_SAFE_TOOLS.includes(tool)) throw new Error('agent-desktop tool is not allowed.');
    // Closest trusted boundary to the driver transport: every caller (agent
    // bridge, HTTP route, internal inventory reads) passes through here, so
    // the argument policy cannot be bypassed by reaching further in.
    const guarded = guardAgentDesktopCall(tool, args);
    const release = this.admission?.enter(`automation.computer.${tool}`);
    this.dispatching++;
    this.activityRevision++;
    try {
      if (signal?.aborted) throw new Error('agent-desktop request was cancelled.');
      await this.ensureStarted();
      return await this.request('tools/call', { name: tool, arguments: guarded.arguments }, 60_000, signal);
    } finally {
      this.dispatching--;
      this.activityRevision++;
      release?.();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.activityRevision++;
    this.closing++;
    try {
      const child = this.child;
      if (!child) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000);
      });
    } finally {
      this.closing--;
      this.activityRevision++;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.shuttingDown) throw new Error('agent-desktop client is shutting down.');
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const executable = await findExecutable();
      if (!executable) throw new Error('agent-desktop is not installed or not on PATH.');
      const child = spawn(executable, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      this.child = child;
      this.transportUncertain = false;
      const reader = readline.createInterface({ input: child.stdout });
      reader.on('line', (line) => this.handleLine(line));
      child.stderr.on('data', () => { /* diagnostic noise; not part of the JSON-RPC contract */ });
      child.once('exit', () => {
        this.failAll(child, new Error('agent-desktop exited unexpectedly.'), true);
      });
      child.once('error', (cause) => {
        this.failAll(child, cause instanceof Error ? cause : new Error('agent-desktop failed to start.'), true);
      });
      const initialized = await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gajae-code-app', version: '0.1.0' },
      }, 10_000);
      const version = mcpServerVersion(initialized);
      if (!isAgentDesktopSchemaSupported(version)) {
        const message = `Unsupported agent-desktop schema ${version ?? 'unknown'}; reviewed schema is ${AGENT_DESKTOP_SCHEMA_VERSION}.`;
        if (this.child === child) this.child = undefined;
        child.kill();
        throw new Error(message);
      }
      this.notify('notifications/initialized', {});
    })().finally(() => {
      this.starting = undefined;
      this.activityRevision++;
    });
    return this.starting;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('agent-desktop is unavailable.'));
    if (signal?.aborted) return Promise.reject(new Error('agent-desktop request was cancelled.'));
    const id = `${++this.sequence}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        abandon(new Error('agent-desktop request timed out.'));
      }, timeoutMs);
      const abandon = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending || pending.uncertain) return;
        clearTimeout(timer);
        pending.uncertain = true;
        this.activityRevision++;
        pending.reject(error);
      };
      const onAbort = () => {
        abandon(new Error('agent-desktop request was cancelled.'));
        this.notify('notifications/cancelled', { requestId: id, reason: 'Client request cancelled.' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        child,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
        ...(method === 'tools/call' ? { tool: String(params.name) } : {}),
      });
      this.activityRevision++;
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { abandon(error instanceof Error ? error : new Error('agent-desktop write failed.')); }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.activityRevision++;
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
    catch (error) { this.failAll(child, error instanceof Error ? error : new Error('agent-desktop write failed.')); }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.jsonrpc !== '2.0' || (!Object.hasOwn(message, 'result') && !message.error)) {
      clearTimeout(pending.timer);
      pending.uncertain = true;
      this.activityRevision++;
      pending.reject(new Error('agent-desktop returned an invalid response.'));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.activityRevision++;
    if (message.error) pending.reject(new Error(message.error.message || 'agent-desktop request failed.'));
    else pending.resolve(message.result);
  }

  private failAll(child: ChildProcessWithoutNullStreams, error: Error, closed = false): void {
    if (child !== this.child) return;
    this.transportUncertain = !closed;
    this.activityRevision++;
    if (closed) this.child = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      if (closed && !pending.tool) this.pending.delete(id);
      else pending.uncertain = true;
      pending.reject(error);
    }
  }
}

/**
 * agent-desktop's MCP tool results carry `structuredContent.data` with the
 * already-parsed CLI envelope's `data` object (verified live against
 * `desktop_version`: `structuredContent: { command, data: { os, target,
 * version }, ok, version }`), alongside an equivalent JSON-text
 * `content[0].text` for text-only MCP clients. Reads the structured form
 * directly rather than re-parsing text that was never serialized for us.
 */
function envelopeDataField(result: unknown, field: string): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  const data = (structured as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

export function isAgentDesktopSafeTool(value: unknown): value is AgentDesktopSafeTool {
  return typeof value === 'string' && (AGENT_DESKTOP_SAFE_TOOLS as readonly string[]).includes(value);
}
