import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import net, { type Server as NetServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GJC_BROWSER_BACKENDS,
  isEgoSupportedPlatform,
  probeEgoReadiness,
  testEgoBrowserConnection,
  type EgoConnectionTestResult,
  type EgoFrame,
  type EgoReadinessReport,
  type GjcBrowserBackend,
} from '@/gjc-engine.js';
import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import type { DesktopNativeInit } from '@/shared/desktop-native-init.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';
import { isBuiltinBrowserBinding, type BuiltinBrowserBinding, type BuiltinBrowserCommand } from '../../../shared/builtinBrowserProtocol.js';

import { AutomationGrantStore, type AutomationGrant } from './automation-grants.js';
import { browserBackendStore } from './browser-backend.js';
import { computerUseStore } from './computer-use.js';
import { egoActivityReader, egoActivityStore, type EgoActivityResponse } from './ego-activity.js';
import { TauriBrowserClient } from './tauri-browser-client.js';
import { automationOrigin } from './automation-url.js';
import {
  AgentDesktopClient,
  isAgentDesktopSafeTool,
  type AgentDesktopSafeTool,
  type AgentDesktopStatus,
} from './agent-desktop-client.js';
import { LocalComputerTransport, RemoteComputerTransport, type ComputerTransport } from './computer-transport.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';
import { RemoteComputerHub } from './remote-computer-hub.js';
import {
  guardAgentDesktopCall,
  requiresApplicationIdentity,
  snapshotIdFromRef,
} from './agent-desktop-capability.js';

type BridgeRequest = {
  id: string;
  token: string;
  surface: 'browser' | 'computer';
  sessionId: string;
  operation?: 'open' | 'close' | 'command' | 'authorize';
  payload?: Record<string, unknown>;
  tool?: string;
  arguments?: Record<string, unknown>;
};

type AgentDesktopApplication = {
  name?: unknown;
  pid?: unknown;
};

type AgentDesktopWindow = {
  pid?: unknown;
  id?: unknown;
};

type AgentDesktopApplicationAuthorization = {
  granted: boolean;
  application: string | null;
  label: string | null;
};

const MAX_BRIDGE_LINE = 2 * 1024 * 1024;
/** Upper bound on remembered snapshot -> application links (oldest evicted first). */
const MAX_TRACKED_SNAPSHOTS = 256;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeBridgeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function structuredObject(value: unknown): Record<string, unknown> {
  const record = object(value);
  return object(record.structuredContent ?? record.result ?? record);
}

/** `apps` from a `desktop_list_apps` call's `structuredContent.data`. */
function applicationRecords(value: unknown): AgentDesktopApplication[] {
  const apps = structuredObject(structuredObject(value).data).apps;
  return Array.isArray(apps)
    ? apps.filter((app): app is AgentDesktopApplication => Boolean(app && typeof app === 'object' && !Array.isArray(app)))
    : [];
}

/**
 * Windows from a `desktop_list_windows` call.
 *
 * agent-desktop 1.2.0 answers with a bare array under `data`
 * (`{"command":"list-windows","data":[...]}`), unlike `desktop_list_apps`,
 * which nests its records under `data.apps`. Reading only `data.windows` made
 * every `window_id` resolve to "no such window", so window-addressed calls
 * failed identity resolution even for a window that was listed a moment ago.
 * Both shapes are accepted.
 */
function windowRecords(value: unknown): AgentDesktopWindow[] {
  const data = structuredObject(value).data;
  const windows = Array.isArray(data) ? data : object(data).windows;
  return Array.isArray(windows)
    ? windows.filter((window): window is AgentDesktopWindow => Boolean(window && typeof window === 'object' && !Array.isArray(window)))
    : [];
}

/**
 * Driver dead ends that read as final but are not.
 *
 * `desktop_snapshot {app}` answers "Application 'X' is running but has no
 * matching window" whenever the app owns no window the accessibility tree can
 * see: Finder before one is opened, or an app whose last window was closed. A
 * live session read that as "the data does not exist" and told the person their
 * Downloads folder was empty. The message now names the next move, so the loop
 * continues instead of ending on a wrong conclusion.
 */
function computerRecoveryHint(tool: string, message: string): string {
  if (/has no matching window/u.test(message)) {
    return `${message}\nThe application is running but owns no window the accessibility tree can see. Open or restore one and snapshot again: for Finder send desktop_press {combo:"cmd+n", app:"Finder"} (cmd+shift+d opens Downloads), otherwise retry desktop_launch {app, activate:true} or pick a window from desktop_list_windows.`;
  }
  if (/is not exposed through accessibility/u.test(message)) {
    return `${message}\n${tool} cannot read that window. Use a window from desktop_list_windows whose "accessible" is true, or address the app instead of the window_id.`;
  }
  return message;
}

function computerFailure(tool: string, cause: unknown): Error {
  return new Error(computerRecoveryHint(tool, cause instanceof Error ? cause.message : String(cause)));
}

function agentDesktopToolError(value: unknown): string | null {
  const record = object(value);
  if (record.isError !== true) return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const message = content
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
  return message || 'agent-desktop rejected the request.';
}

// Application identity, discovery classification and the argument policy all
// live in ./agent-desktop-capability.ts so that the authorize path and the
// execute path can never disagree about what a call requires.

/**
 * agent-desktop's `desktop_*` tools are stateless per call (no session label
 * is threaded through every request, unlike CUA Driver's `start_session`/
 * `end_session` wrapping); `desktop_session_start`/`desktop_session_end` are
 * just two more tools in the enum, dispatched directly like any other.
 */

export function automationSupport(platform: NodeJS.Platform, arch: string, environment: NodeJS.ProcessEnv) {
  const override = environment.GAJAE_AUTOMATION === '1';
  const desktop = environment.GJC_DESKTOP === '1';
  const mac = platform === 'darwin' && arch === 'arm64';
  return {
    // A launch candidate only. Public capability requires an authenticated native status below.
    browser: desktop && mac,
    computer: override || (desktop && mac),
  };
}

export class AutomationService {
  // Native status is synchronized when the supervisor binding arrives and by
  // the ordinary status route. Restart readers consume only that cache.
  readonly browser = new TauriBrowserClient({ refreshOnBinding: true });
  readonly cua = new AgentDesktopClient();
  readonly grants = new AutomationGrantStore();
  /**
   * `${sessionId}\u0000${snapshotId}` -> the application that produced the
   * snapshot. Interaction tools (`desktop_click`, `desktop_type`, ...) carry
   * only a `ref_id`, so the snapshot is their only link back to an approved
   * application; without this every one of them failed resolution before
   * dispatch. Holds no authority - grants are still checked against the
   * resolved application on every call.
   */
  private readonly snapshotApplications = new Map<string, string>();
  /**
   * One in-flight inventory read per session and kind.
   *
   * Inventory is deliberately never cached across calls: a recycled window_id
   * or a reused pid has to fail closed, so the owning application is re-read
   * from the live driver on every dispatch. This only stops two concurrent
   * readers of the same list from paying for it twice.
   */
  private readonly inventoryReads = new Map<string, Promise<unknown>>();
  /** The app's browser backend choice for GJC runs; the runtime owns everything it selects. */
  readonly browserBackend = browserBackendStore;
  /** Opt-in rendering of the agent's ego browser state; off by default. */
  readonly egoActivity = egoActivityStore;
  /** Opt-in native application control through agent-desktop; off by default. */
  readonly computerUse = computerUseStore;
  /** Pairing state for outbound-only agent-desktop companions. */
  readonly remoteDevices = new RemoteComputerDeviceRegistry();
  readonly remoteComputerHub = new RemoteComputerHub(this.remoteDevices);
  private readonly localTransport = new LocalComputerTransport(this.cua);

  /**
   * The transport computer calls route through: the paired remote companion
   * selected in Settings when one is selected and enabled, otherwise this
   * server's own local CUA Driver. Re-read on every call rather than cached,
   * so disabling or switching the selected device in Settings takes effect
   * on the very next call with no restart.
   */
  private transport(): ComputerTransport {
    const deviceId = this.remoteDevices.selectedDeviceId();
    if (!deviceId) return this.localTransport;
    try {
      this.remoteDevices.dispatchable(deviceId);
    } catch {
      return this.localTransport;
    }
    return new RemoteComputerTransport(deviceId, this.remoteComputerHub);
  }
  private readonly egoActivityReader = egoActivityReader;
  private readonly capabilities = automationSupport(process.platform, process.arch, process.env);
  /**
   * Computer automation is usable either because this machine is itself a
   * native macOS desktop that can run agent-desktop locally, or because the
   * user paired and selected a remote companion to drive instead. Those are
   * independent paths: a server with no local desktop session (a Docker
   * container, a Linux box) still has a usable computer transport once a
   * remote device is selected, and must not need any environment override to
   * reach it.
   */
  private computerCapable(): boolean {
    if (this.capabilities.computer) return true;
    const deviceId = this.remoteDevices.selectedDeviceId();
    if (!deviceId) return false;
    try {
      this.remoteDevices.dispatchable(deviceId);
      return true;
    } catch {
      return false;
    }
  }
  get supported(): boolean { return this.browser.isReady(); }
  private readonly bridgeToken = randomBytes(32).toString('hex');
  private readonly bridgePath = process.env.GAJAE_AUTOMATION_SOCKET
    ?? join(tmpdir(), `gajae-automation-${process.pid}.sock`);
  private bridge?: NetServer;
  private readonly bridgeConnections = new Set<Socket>();
  private bridgeStarting?: Promise<void>;
  private admission?: DesktopWorkAdmission;
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0;
  private dispatching = 0;
  private closing = 0;

  constructor(admission?: DesktopWorkAdmission) {
    this.configureDesktopRestartAdmission(admission);
  }

  configureNativeInitialization(initialization: DesktopNativeInit): void {
    this.browser.configureInitialization(initialization);
  }

  configureDesktopRestartAdmission(admission?: DesktopWorkAdmission): void {
    this.admission = admission;
    this.browser.configureDesktopRestartAdmission(admission);
    this.cua.configureDesktopRestartAdmission(admission);
    this.activityRevision++;
  }

  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }

  snapshotActivity(): DesktopOwnerActivity {
    return {
      owner: 'automation', generation: this.getGeneration(), complete: true,
      starting: Number(Boolean(this.bridgeStarting)),
      queued: 0, running: this.dispatching,
      settling: this.closing,
      approvals: 0, retained: 0, unknown: [],
    };
  }

  private enter(source: string): () => void {
    const release = this.admission?.enter(`automation.${source}`);
    this.dispatching++;
    this.activityRevision++;
    return () => {
      this.dispatching--;
      this.activityRevision++;
      release?.();
    };
  }

  async status() {
    const release = this.enter('status');
    try {
      const computerCapable = this.computerCapable();
      const [browser, cua] = await Promise.all([
        this.browser.status().catch(() => ({ state: 'unavailable' as const, ready: false, engine: 'webview' as const })),
        computerCapable
          ? this.transport().status()
          : Promise.resolve({ installed: false, daemon: 'unknown' as const } as AgentDesktopStatus),
      ]);
      return {
        supported: browser.ready,
        capabilities: { browser: browser.ready, computer: computerCapable },
        computerSupported: computerCapable,
        platform: process.platform,
        architecture: process.arch,
        browser,
        cua,
      };
    } finally { release(); }
  }

  /** Read-only Ego diagnostics. This never starts the worker or executes a CLI. */
  egoReadiness(): EgoReadinessReport {
    return probeEgoReadiness({
      home: homedir(),
      agentDir: process.env.GJC_WORKER_AGENT_DIR ?? join(homedir(), '.gjc', 'agent'),
      path: process.env.PATH,
      platform: process.platform,
    });
  }

  /** Explicit Settings action only: the service never calls this during status/GET. */
  async testEgoConnection(): Promise<EgoConnectionTestResult> {
    return testEgoBrowserConnection({ home: homedir(), path: process.env.PATH });
  }

  /**
   * What the agent's ego browser is doing for one app session.
   *
   * Unlike the readiness probe this may execute the ego CLI, so it stays
   * bounded by the reader: nothing runs unless the surface is enabled and the
   * backend is ego, the observation script is fixed and read-only, and one
   * execution is shared across sessions inside a short window.
   */
  async egoActivitySnapshot(appSessionId?: string): Promise<EgoActivityResponse> {
    return this.egoActivityReader.snapshot(appSessionId);
  }

  /** One frame of a page this session's own ego Space is showing, or nothing. */
  async egoActivityFrame(appSessionId: string, spaceId: number, label: string): Promise<EgoFrame | undefined> {
    return this.egoActivityReader.frame(appSessionId, spaceId, label);
  }

  /** Browser backend choices are platform-gated; an existing stored value is not rewritten. */
  browserBackends(): readonly GjcBrowserBackend[] {
    return isEgoSupportedPlatform(process.platform)
      ? GJC_BROWSER_BACKENDS
      : GJC_BROWSER_BACKENDS.filter((backend) => backend !== 'ego');
  }

  async openBrowser(
    sessionId: string,
    payload: { url?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const release = this.enter('browser.open');
    try {
      await this.requireBrowserSupported();
      return await this.browser.open(sessionId, payload, signal);
    }
    finally { release(); }
  }

  async commandBrowser(sessionId: string, command: BuiltinBrowserCommand, signal?: AbortSignal, expected?: unknown): Promise<unknown> {
    const release = this.enter('browser.command');
    try {
      await this.requireBrowserSupported();
      if (!isBuiltinBrowserBinding(expected)) throw new Error('browser_observation_required');
      return await this.browser.command(sessionId, command, expected, signal);
    }
    finally { release(); }
  }

  async stopSession(sessionId: string): Promise<unknown> {
    const release = this.enter('session.stop');
    try {
      this.grants.clearSession(sessionId);
      const signal = AbortSignal.timeout(2_500);
      const [browser] = await Promise.allSettled([
        this.browser.close(sessionId, signal),
      ]);
      return browser.status === 'fulfilled' ? browser.value : { closed: false };
    } finally { release(); }
  }

  grant(grant: AutomationGrant): void {
    const release = this.enter('grant');
    try {
      const value = grant.kind === 'origin' ? automationOrigin(grant.value) : grant.value.trim();
      if (!value) throw new Error('A web origin is required for this grant.');
      this.grants.grant({ ...grant, value });
    } finally { release(); }
  }

  async authorizeBrowser(
    sessionId: string,
    payload: { url?: unknown; scope?: unknown },
    signal?: AbortSignal,
  ): Promise<{ granted: boolean; origin: string | null; binding: BuiltinBrowserBinding | null }> {
    const release = this.enter('browser.authorize');
    try {
      await this.requireBrowserSupported();
      const state = await this.browser.state(sessionId, signal);
      const rawUrl = typeof payload.url === 'string' ? payload.url
        : state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
      if (!rawUrl) throw new Error('Open a browser tab before requesting browser access.');
      const origin = automationOrigin(rawUrl);
      if (!origin) return { granted: true, origin: null, binding: state.binding };
      if (payload.scope === 'session' || payload.scope === 'always') {
        this.grant({
          kind: 'origin',
          value: origin,
          scope: payload.scope,
          ...(payload.scope === 'session' ? { sessionId } : {}),
        });
      }
      return { granted: this.grants.has('origin', origin, sessionId), origin, binding: state.binding };
    } finally { release(); }
  }

  async authorizeComputer(
    sessionId: string,
    payload: { tool?: unknown; arguments?: unknown; scope?: unknown; application?: unknown },
    signal?: AbortSignal,
  ): Promise<AgentDesktopApplicationAuthorization> {
    this.requireComputerSupported();
    const release = this.enter('computer.authorize');
    try {
      if (!isAgentDesktopSafeTool(payload.tool)) throw new Error('Unsupported agent-desktop tool.');
      const rawArgs = object(payload.arguments);
      // Authorization must inspect the exact same normalized record that will
      // reach callComputer. Reject policy-denied or malformed requests before
      // resolving inventory, prompting, or materializing an application grant.
      const { arguments: args } = guardAgentDesktopCall(payload.tool, rawArgs);
      const { application, label } = await this.resolveComputerApplication(
        sessionId,
        payload.tool,
        args,
        typeof payload.application === 'string' ? payload.application.trim() : '',
        signal,
      );
      if (!application) return { granted: true, application: null, label: null };
      if (payload.scope === 'session' || payload.scope === 'always') {
        this.grant({
          kind: 'application',
          value: application,
          scope: payload.scope,
          ...(payload.scope === 'session' ? { sessionId } : {}),
        });
      }
      return {
        granted: this.grants.has('application', application, sessionId),
        application,
        label,
      };
    } finally { release(); }
  }

  /**
   * Resolve the application identity a call is bound to.
   *
   * Returns `{ application: null }` for reviewed read-only discovery reads, and
   * throws when a call that needs an application identity cannot produce one.
   * Shared by `authorizeComputer` (resolve + prompt) and `callComputer`
   * (enforce), so approval and execution always agree on the target.
   */
  private async resolveComputerApplication(
    sessionId: string,
    tool: AgentDesktopSafeTool,
    args: Record<string, unknown>,
    hint: string,
    signal?: AbortSignal,
  ): Promise<{ application: string | null; label: string | null }> {
    let application = hint;
    let label: string | null = null;

    if (!application && tool === 'desktop_launch') {
      application = typeof args.app === 'string' ? args.app.trim() : '';
    }
    if (!application && typeof args.app === 'string' && args.app.trim()) {
      application = args.app.trim();
    }
    // A ref_id addresses an element, not an application. Recover the owning
    // application from the snapshot namespace the ref was minted in. Refs are
    // session-scoped: a snapshot taken by another session never resolves here.
    if (!application && typeof args.ref_id === 'string') {
      const snapshotId = snapshotIdFromRef(args.ref_id);
      const remembered = snapshotId
        ? this.snapshotApplications.get(`${sessionId}\u0000${snapshotId}`)
        : undefined;
      if (remembered) {
        application = remembered;
        label = remembered;
      }
    }

    // A batch is one MCP round trip for a whole sequence, so the model reaches
    // for it whenever several steps belong together. Its ref_ids still name the
    // snapshot they were minted in, which is the same application link an
    // interaction tool uses - read it from there instead of demanding an `app`
    // argument the batch tool does not document.
    if (!application && tool === 'desktop_batch') {
      const batched = this.batchApplication(sessionId, args);
      if (batched) {
        application = batched;
        label = batched;
      }
    }

    const windowId = typeof args.window_id === 'string' ? args.window_id : undefined;
    const needsInventory = tool === 'desktop_launch' || (!application && windowId !== undefined);
    if (!application && needsInventory) {
      const window = (await this.inventoryWindows(sessionId, signal)).find((candidate) => candidate.id === windowId);
      let pid: number | undefined;
      if (window && typeof window.pid === 'number' && Number.isSafeInteger(window.pid) && window.pid > 0) {
        pid = window.pid;
      }
      if (pid !== undefined) {
        const match = (await this.inventoryApps(sessionId, signal)).find((app) => app.pid === pid);
        if (match && typeof match.name === 'string' && match.name.trim()) {
          application = match.name.trim();
          label = application;
        }
      }
    }

    if (!application) {
      if (!requiresApplicationIdentity(tool, args)) return { application: null, label: null };
      throw new Error(
        `${tool} requires a resolvable application identity. Take a desktop_snapshot or desktop_find scoped to the app (pass app, or run desktop_launch first) and address elements with a ref_id from that result.`,
      );
    }
    return { application, label: label || application };
  }

  /**
   * Records which application minted each snapshot. Called after a successful
   * `desktop_snapshot`/`desktop_find`, so a later `ref_id` can be traced back
   * to the application the person approved.
   */
  private rememberSnapshotApplication(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
  ): void {
    if (tool !== 'desktop_snapshot' && tool !== 'desktop_find') return;
    const data = object(structuredObject(result).data);
    const snapshotId = typeof data.snapshot_id === 'string' ? data.snapshot_id : '';
    const declared = typeof data.app === 'string' && data.app.trim() ? data.app.trim() : '';
    const requested = typeof args.app === 'string' ? args.app.trim() : '';
    const application = declared || requested;
    if (!snapshotId || !application) return;
    const key = `${sessionId}\u0000${snapshotId}`;
    this.snapshotApplications.delete(key);
    this.snapshotApplications.set(key, application);
    while (this.snapshotApplications.size > MAX_TRACKED_SNAPSHOTS) {
      const oldest = this.snapshotApplications.keys().next().value;
      if (oldest === undefined) break;
      this.snapshotApplications.delete(oldest);
    }
  }

  /**
   * The single application a `desktop_batch` addresses, or null.
   *
   * Every ref_id in the batch has to resolve to the same application: a batch
   * that mixes two apps would otherwise be authorized by whichever one happened
   * to be found first, which is exactly the cross-application reach the grant
   * model exists to prevent.
   */
  private batchApplication(sessionId: string, args: Record<string, unknown>): string | null {
    if (typeof args.commands_json !== 'string') return null;
    let steps: unknown;
    try { steps = JSON.parse(args.commands_json); } catch { return null; }
    if (!Array.isArray(steps)) return null;
    const applications = new Set<string>();
    for (const step of steps) {
      const ref = object(object(step).args).ref_id;
      if (typeof ref !== 'string') continue;
      const snapshotId = snapshotIdFromRef(ref);
      const application = snapshotId ? this.snapshotApplications.get(`${sessionId}\u0000${snapshotId}`) : undefined;
      if (!application) return null;
      applications.add(application);
    }
    return applications.size === 1 ? [...applications][0] : null;
  }

  /** One inventory read per session and kind at a time: concurrent callers share it. */
  private async inventoryRead<T>(sessionId: string, kind: 'windows' | 'apps', read: () => Promise<T>): Promise<T> {
    const key = `${sessionId}\u0000${kind}`;
    const inFlight = this.inventoryReads.get(key);
    if (inFlight) return await inFlight as T;
    const pending = read().finally(() => { this.inventoryReads.delete(key); });
    this.inventoryReads.set(key, pending);
    return await pending;
  }

  private async inventoryWindows(sessionId: string, signal?: AbortSignal): Promise<AgentDesktopWindow[]> {
    return await this.inventoryRead(sessionId, 'windows', async () => windowRecords(
      await this.transport().call(sessionId, 'desktop_list_windows', {}, signal),
    ));
  }

  private async inventoryApps(sessionId: string, signal?: AbortSignal): Promise<AgentDesktopApplication[]> {
    return await this.inventoryRead(sessionId, 'apps', async () => applicationRecords(
      await this.transport().call(sessionId, 'desktop_list_apps', {}, signal),
    ));
  }

  async callComputer(sessionId: string, tool: AgentDesktopSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.requireComputerSupported();
    const release = this.enter('computer.call');
    try {
      // Same policy function the driver transport enforces, applied here so a
      // denied call costs no driver round-trip and never resolves identity.
      // guardAgentDesktopCall is idempotent.
      const { arguments: scopedArgs } = guardAgentDesktopCall(tool, args);
      // Trusted server-side authority gate. Every caller reaching callComputer
      // — the authenticated Unix bridge, POST /api/automation/computer/:id/call,
      // and any future one — is checked here. Reaching this method never confers
      // mutation authority; only a live application grant does. The identity is
      // re-resolved from the live driver inventory on each call, so a window_id
      // that no longer belongs to the approved application fails closed.
      if (requiresApplicationIdentity(tool, scopedArgs)) {
        const { application, label } = await this.resolveComputerApplication(sessionId, tool, scopedArgs, '', signal);
        if (!application || !this.grants.has('application', application, sessionId)) {
          throw new Error(`Computer access to ${label ?? application ?? 'this application'} was not granted.`);
        }
      }
      let result: unknown;
      try {
        result = await this.transport().call(sessionId, tool, scopedArgs, signal);
      } catch (cause) {
        // The remote transport rejects instead of returning isError; give both
        // shapes the same recovery guidance.
        throw computerFailure(tool, cause);
      }
      const error = agentDesktopToolError(result);
      if (error) throw new Error(computerRecoveryHint(tool, error));
      this.rememberSnapshotApplication(sessionId, tool, scopedArgs, result);
      return result;
    } finally { release(); }
  }

  async startBridge(): Promise<void> {
    if (!this.capabilities.browser && !this.computerCapable()) return;
    if (this.bridgeStarting) return this.bridgeStarting;
    if (this.bridge) return;
    const release = this.enter('bridge.start');
    this.bridgeStarting = (async () => {
      await mkdir(join(tmpdir()), { recursive: true });
      const bridge = net.createServer((socket) => {
        this.bridgeConnections.add(socket);
        this.activityRevision++;
        socket.once('close', () => {
          this.bridgeConnections.delete(socket);
          this.activityRevision++;
        });
        this.handleBridgeSocket(socket);
      });
      await new Promise<void>((resolve, reject) => {
        bridge.once('error', reject);
        bridge.listen(this.bridgePath, () => {
          bridge.off('error', reject);
          resolve();
        });
      });
      this.bridge = bridge;
      this.activityRevision++;
      if (process.platform !== 'win32') await chmod(this.bridgePath, 0o600);
      process.env.GJC_AUTOMATION_SOCKET = this.bridgePath;
      process.env.GJC_AUTOMATION_TOKEN = this.bridgeToken;
    })().finally(() => {
      this.bridgeStarting = undefined;
      release();
    });
    return this.bridgeStarting;
  }

  async shutdown(): Promise<void> {
    this.closing++;
    this.activityRevision++;
    try {
      if (this.bridgeStarting) await this.bridgeStarting.catch(() => {});
      await Promise.allSettled([
        this.browser.shutdown(),
      ]);
      await this.cua.shutdown();
      const bridge = this.bridge;
      for (const socket of this.bridgeConnections) socket.destroy();
      // Node removes the Unix socket it bound when close completes. A service
      // that never bound must not unlink another server's configured socket.
      if (bridge) await new Promise<void>((resolve) => bridge.close(() => resolve()));
      this.bridge = undefined;
      this.activityRevision++;
      if (process.env.GJC_AUTOMATION_SOCKET === this.bridgePath && process.env.GJC_AUTOMATION_TOKEN === this.bridgeToken) {
        delete process.env.GJC_AUTOMATION_SOCKET;
        delete process.env.GJC_AUTOMATION_TOKEN;
      }
    } finally {
      this.closing--;
      this.activityRevision++;
    }
  }

  private async requireBrowserSupported(): Promise<void> {
    const status = await this.browser.status();
    if (!status.ready) throw new Error('builtin_browser_unavailable');
  }

  private requireComputerSupported(): void {
    if (!this.computerCapable()) throw new Error('No computer automation transport is available: this machine has no local agent-desktop install and no remote companion is paired and selected.');
    // The user's opt-in is checked at the same choke point as the platform
    // capability, so every caller - the worker bridge, the HTTP route, a
    // future one - fails closed while it is off, whether or not the session
    // was ever offered the tool.
    if (!this.computerUse.get()) throw new Error('Computer use is off. Turn it on in Settings > Automation.');
  }

  private handleBridgeSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BRIDGE_LINE) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleBridgeLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleBridgeLine(socket: Socket, line: string): Promise<void> {
    let request: BridgeRequest | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once('close', abort);
    try {
      request = JSON.parse(line) as BridgeRequest;
      if (request.token !== this.bridgeToken || !safeBridgeId(request.id) || !safeBridgeId(request.sessionId)) {
        throw new Error('Unauthorized automation bridge request.');
      }
      // Unix sockets bypass the HTTP/WS ingress wrappers. This authenticated
      // handler owns dispatch until settlement, even after socket disconnect.
      release = this.enter('bridge.request');
      let result: unknown;
      if (request.surface === 'browser') {
        if (request.operation === 'open') result = await this.openBrowser(request.sessionId, object(request.payload), controller.signal);
        else if (request.operation === 'close') result = await this.stopSession(request.sessionId);
        else if (request.operation === 'authorize') result = await this.authorizeBrowser(request.sessionId, object(request.payload), controller.signal);
        else result = await this.commandBrowser(
          request.sessionId,
          object(request.payload?.command) as BuiltinBrowserCommand,
          controller.signal,
          request.payload?.expected,
        );
      } else if (request.surface === 'computer' && request.operation === 'authorize') {
        result = await this.authorizeComputer(request.sessionId, {
          tool: request.tool,
          arguments: request.arguments,
          ...object(request.payload),
        }, controller.signal);
      } else if (request.surface === 'computer' && isAgentDesktopSafeTool(request.tool)) {
        result = await this.callComputer(request.sessionId, request.tool, object(request.arguments), controller.signal);
      } else {
        throw new Error('Unsupported automation bridge request.');
      }
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        id: request && typeof request.id === 'string' ? request.id : 'invalid',
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 1_000) : 'Automation bridge request failed.',
      })}\n`);
    } finally {
      socket.off('close', abort);
      release?.();
    }
  }
}

export const automationService = new AutomationService();

/**
 * Parent composition injects the SAME server-owned admission into all owners.
 * Producer/owner map: docs/DESKTOP-UPDATE-ADMISSION.md (automation, browser, CUA).
 * Readers below never call status(), spawn, drain, cancel, or shutdown.
 */
export function configureDesktopRestartAdmission(admission?: DesktopWorkAdmission, service = automationService): void {
  service.configureDesktopRestartAdmission(admission);
}

export function createAutomationDesktopRestartReader(service = automationService) {
  return Object.freeze({ getGeneration: () => service.getGeneration(), read: () => service.snapshotActivity() });
}

export function createBrowserDesktopRestartReader(browser = automationService.browser) {
  return Object.freeze({ getGeneration: () => browser.getGeneration(), read: () => browser.snapshotActivity() });
}

export function createComputerDesktopRestartReader(service = automationService) {
  return Object.freeze({
    getGeneration: () => `${service.cua.getGeneration()}:${service.getGeneration()}`,
    read: (): DesktopOwnerActivity => {
      const activity = service.cua.snapshotActivity();
      const automation = service.snapshotActivity();
      const unknown = [...new Set([...activity.unknown, ...automation.unknown])];
      return {
        ...activity, generation: `${activity.generation}:${automation.generation}`,
        retained: activity.retained + automation.retained,
        complete: activity.complete && automation.complete, unknown,
      };
    },
  });
}
