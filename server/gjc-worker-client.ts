import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { appendFileSync, chownSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import type { DesktopOwnerActivity } from '../shared/desktopUpdateProtocol.js';
import type { GjcGoalCommand, GjcGoalSnapshot, GjcGoalScope } from '../shared/gjc-goal.js';

import { relocateLiveGjcTranscript } from './gjc-transcript-store.js';
import {
  GJC_ASIDE_UNAVAILABLE_CODE,
  GJC_ASIDE_UNAVAILABLE_MESSAGE,
  GJC_CLEANUP_UNCONFIRMED_CODE,
  GJC_CLEANUP_UNCONFIRMED_MESSAGE,
  GJC_AGENT_TOOL_NAMES,
  GJC_INVALID_PERMISSIONS_CODE,
  GJC_INVALID_PERMISSIONS_MESSAGE,
  GJC_MODEL_UNRESOLVED_CODE,
  GJC_MODEL_UNRESOLVED_MESSAGE,
  GJC_WORKER_PROTOCOL_VERSION,
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
  GjcWorkerNdjsonDecoder,
  GjcWorkerProtocolError,
  GjcWorkerRequestTracker,
  createWindowsJobLaunch,
  serializeGjcWorkerFrame,
  type GjcBranchedSession,
  type GjcWorkerEventFrame,
  type GjcWorkerGlobalEventMethod,
  type GjcWorkerRequestFrame,
  type GjcWorkerRequestMethod,
  type GjcWorkerResponsePayload,
  type GjcBrowserBackend,
  type GjcWorkerResponseFrame,
  type HostControlRunPolicy,
  type JsonObject,
} from './gjc-engine.js';
import { notifyRunFailed, notifyRunStopped, workerNotificationsEnv } from './modules/notifications/index.js';
import { childEnvironment } from './shared/child-environment.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  getGjcLiveSessionRoot,
  registerGjcRuntimeModelCatalogLoader,
  registerGjcRuntimeProviderQuotaLoader,
} from './shared/utils.js';

type RunStoppedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  stopReason: string;
};

type RunFailedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  error: string;
};

type RunStoppedNotifier = (notification: RunStoppedNotification) => unknown;
type RunFailedNotifier = (notification: RunFailedNotification) => unknown;
export type GjcApprovalDecision = { allow: boolean; always?: boolean; updatedInput?: unknown; message?: string; rememberEntry?: unknown };
export type GjcWorkerOptions = Record<string, unknown> & {
  sessionId?: string | null;
  cwd?: string;
  projectPath?: string;
  sessionSummary?: string;
  notificationOwner?: 'terminal-adapter';
};
type GjcOptionsEnricher = (options: GjcWorkerOptions) => Promise<GjcWorkerOptions>;
/** Optional application-owned ingress accounting; the engine owns no app authority. */
export type GjcWorkerDesktopAdmission = { acquire(source: string): { release(): void } };
type WorkerActivityObservation = Extract<Extract<GjcWorkerResponseFrame, { method: 'worker.activity' }>['payload'], { ok: true }>['result'];
export type GjcWorkerWriter = { send(value: unknown): void; setSessionId?(id: string): void; getAppSessionId?(): string | undefined; userId?: string | number | null };
type Child = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type GjcWorkerSpawnRun = {
  runId: string;
  appSessionId: string;
  message: string;
  options?: GjcWorkerOptions;
  writer: GjcWorkerWriter;
};
export type GjcWorkerOutcome = 'not_started' | 'aborted' | 'completed' | 'reaped' | 'unconfirmed';
export type GjcWorkerAbortOutcome = 'not_started' | 'aborted' | 'unconfirmed';
export type GjcWorkerReapOutcome = 'not_started' | 'reaped' | 'unconfirmed';
export type GjcWorkerRun = {
  started: Promise<void>;
  completion: Promise<void>;
  /** The terminal run outcome. `reaped` proves OS process-tree termination only. */
  outcome?: Promise<GjcWorkerOutcome>;
  phase?: () => 'registered' | 'request_issued' | 'run_terminal';
  abortHandle: string;
};

type Spawn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide?: boolean;
  },
) => Child;

export type GjcWorkerSupervisorRuntime = {
  spawn?: Spawn;
  workerPath?: string;
  corePath?: string;
  compiled?: boolean;
  /** Explicit test/development override; production resolves the bundled Bun first. */
  bunPath?: string;
  /** Allows PATH lookup only for uncompiled development workers. */
  allowDevelopmentBun?: boolean;
  /**
   * Bound on `worker.initialize` (and the Windows launch guard). The Bun worker
   * bootstraps the SDK inside this request — model registry build plus online
   * model discovery — which has been measured at 4-8 s on a loaded developer
   * machine, so the bound has to sit well above a single network round trip.
   */
  initializeTimeoutMs?: number;
  /** Bound on `worker.shutdown` before the process tree is reaped regardless. */
  shutdownTimeoutMs?: number;
  requestTimeoutMs?: number;
  notifyRunStopped?: RunStoppedNotifier;
  notifyRunFailed?: RunFailedNotifier;
  createScope?: () => string;
  diagnostic?: (message: string) => void;
  /** Fulfillment must prove owned process-tree termination, not merely send a signal. */
  killTree?: (child: Child) => void | Promise<void>;
  /** Same proof contract for separately reported run processes. */
  killProcessTree?: (processId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  enrichOptions?: GjcOptionsEnricher;
};

type RunPhase = 'registered' | 'request_issued' | 'run_terminal';
type Run = {
  runId: string;
  appScope: string;
  writer: GjcWorkerWriter;
  options: GjcWorkerOptions;
  aborted: boolean;
  runtimeAborted?: boolean;
  cleanupUnconfirmed?: boolean;
  abortPromise?: Promise<boolean>;
  phase: RunPhase;
  terminalForwarded: boolean;
  terminalFailed: boolean;
  processId?: number;
  providerSessionId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
  resolveOutcome: (outcome: GjcWorkerOutcome) => void;
  resolveStarted: () => void;
  rejectStarted: (error: Error) => void;
  started: boolean;
};

type PendingApproval = {
  runId: string;
  appScope: string;
  message: unknown;
  inFlight: boolean;
};

type ExpiredRequest = {
  method: GjcWorkerRequestMethod;
  sessionId?: string;
};
type GjcWorkerOAuthRequestMethod = Extract<GjcWorkerRequestMethod, `oauth.${string}`>;
export type GjcWorkerOAuthEvent = {
  method: GjcWorkerGlobalEventMethod;
  payload: JsonObject;
};
type GjcWorkerOAuthListener = (event: GjcWorkerOAuthEvent) => void;
const GJC_OAUTH_SUBMIT_MAX_LENGTH = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FAILURE = 'GJC worker failed.';
const REQUEST_TIMEOUT = 'GJC worker request timed out.';
/**
 * Short, cause-specific text for the chat. Protocol responses stay sanitized,
 * but "which part broke" and "what unblocks it" is what makes a failure
 * reportable instead of a shrug. Every one of these is a constant this file
 * owns; no worker-supplied text reaches a caller.
 */
const WORKER_EXITED = 'GJC worker exited unexpectedly';
const WORKER_NOT_STARTED = 'GJC worker did not finish starting in time. Send the message again.';
const WORKER_RESTART_BLOCKED = 'GJC worker could not be restarted after a failed shutdown. Restart the app server.';
const CLEANUP_UNCONFIRMED_FAILURE = `${GJC_CLEANUP_UNCONFIRMED_MESSAGE} Restart the app server.`;
const RUN_FAILED = 'GJC run failed.';
/** Codes the worker sends for a classified run failure; the text stays here. */
const USAGE_LIMIT_CODE = 'usage_limit';
const AUTH_FAILED_CODE = 'auth_failed';
/**
 * `worker.initialize` covers the whole SDK bootstrap (model registry build and
 * online model discovery), measured at 4-8 s on a loaded developer machine. The
 * previous 5 s bound killed a healthy worker mid-bootstrap, and every tab that
 * had reconnected saw only "GJC worker failed.".
 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
class GjcConfigurationError extends Error {}

/**
 * Fixed client-facing text for a failed start/resume response. Worker responses
 * are sanitized, so only codes the app itself can cause map to something more
 * specific than the generic failure.
 */
function runFailureMessage(response: GjcWorkerResponsePayload): string {
  if (!response.ok && response.error.code === GJC_INVALID_PERMISSIONS_CODE) return GJC_INVALID_PERMISSIONS_MESSAGE;
  if (!response.ok && response.error.code === GJC_MODEL_UNRESOLVED_CODE) return GJC_MODEL_UNRESOLVED_MESSAGE;
  if (!response.ok && response.error.code === GJC_ASIDE_UNAVAILABLE_CODE) return GJC_ASIDE_UNAVAILABLE_MESSAGE;
  if (!response.ok && response.error.code === GJC_CLEANUP_UNCONFIRMED_CODE) return CLEANUP_UNCONFIRMED_FAILURE;
  // The worker is alive here; the run itself was refused or failed, so blaming
  // the worker (the generic text) sent operators after the wrong process.
  if (!response.ok && response.error.code === 'run_failed') return RUN_FAILED;
  if (!response.ok && response.error.code === USAGE_LIMIT_CODE) {
    return "The provider's usage limit was reached. Wait for it to reset or switch models.";
  }
  if (!response.ok && response.error.code === AUTH_FAILED_CODE) {
    return 'The provider rejected the saved sign-in. Sign in again.';
  }
  return SAFE_FAILURE;
}

function oauthIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function oauthFailure(code: string): GjcWorkerResponsePayload {
  return { ok: false, error: { code, message: 'OAuth request failed.' } };
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeJsonObject(value: unknown): JsonObject | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return object(parsed) as JsonObject | undefined;
  } catch {
    return undefined;
  }
}

function safeOptions(options: GjcWorkerOptions): JsonObject | undefined {
  const { sessionId: _sessionId, ...rest } = options;
  return safeJsonObject(rest);
}
function containedBy(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!!pathFromRoot && !pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

type GjcSessionPathLookup = (sessionId: string) => Promise<string | undefined>;

async function sessionJsonlPath(sessionId: string): Promise<string | undefined> {
  const { sessionsDb } = await import('./modules/database/index.js');
  const session = sessionsDb.getSessionByProviderSessionId('gjc', sessionId)
    ?? sessionsDb.getSessionById(sessionId);
  return session?.provider === 'gjc' ? session.jsonl_path ?? undefined : undefined;
}

/**
 * Finds a session's transcript by id. The live root keeps sessions flat
 * (`<timestamp>_<id>.jsonl`); the legacy agent root nests them one directory
 * deep (one per working directory), so both layouts are searched.
 */
export function findGjcTranscript(root: string, providerSessionId: string): string | undefined {
  const suffix = `_${providerSessionId}.jsonl`;
  const direct = join(root, `${providerSessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  const children = (directory: string) => {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const entry of children(root)) {
    if (entry.isFile() && entry.name.endsWith(suffix)) return join(root, entry.name);
    if (!entry.isDirectory()) continue;
    for (const child of children(join(root, entry.name))) {
      if (child.isFile() && child.name.endsWith(suffix)) return join(root, entry.name, child.name);
    }
  }
  return undefined;
}

/**
 * Makes a transcript appendable by this process.
 *
 * The runtime verifies owner-only permissions before every append and refuses
 * to write a session another user owns. A transcript written while the app ran
 * as a different user (an older image) therefore fails every resumed turn with
 * `owner_mismatch` even though the file is right there. Taking ownership is the
 * repair the runtime itself attempts for managed directories, so do the same
 * for the transcript and its sidecar directory; a process that may not perform
 * it reports the transcript as unusable, which starts a new session instead of
 * repeating that failure forever.
 */
export function ensureGjcTranscriptOwner(transcriptPath: string, uid = process.getuid?.()): boolean {
  if (uid === undefined) return true;
  const gid = process.getgid?.() ?? uid;
  for (const pathname of [transcriptPath, transcriptPath.replace(/\.jsonl$/u, '')]) {
    try {
      if (statSync(pathname).uid !== uid) chownSync(pathname, uid, gid);
    } catch {
      // A missing sidecar directory is normal; a refused chown is not, and the
      // readback below is what decides whether the run may resume.
    }
  }
  try {
    return statSync(transcriptPath).uid === uid;
  } catch {
    return false;
  }
}

/**
 * Whether this provider session can still be resumed. A recorded path that is
 * gone is searched for by id in the roots the app reads, and the row is
 * repointed at the file it finds - a transcript restored from a backup, or one
 * left behind when the app moved roots, still carries the conversation. Only a
 * transcript that is nowhere is a definite no.
 */
async function resumableGjcTranscript(providerSessionId: string): Promise<boolean> {
  try {
    const { sessionsDb } = await import('./modules/database/index.js');
    const session = sessionsDb.getSessionByProviderSessionId('gjc', providerSessionId)
      ?? sessionsDb.getSessionById(providerSessionId);
    const stored = session?.provider === 'gjc' ? session.jsonl_path : undefined;
    if (stored && existsSync(stored)) {
      // An existing transcript can still be owned by another user: an older
      // image wrote it under a different uid. Taking ownership only on the
      // found-by-id fallback below left the ordinary stored path resuming into
      // `owner_mismatch` on every turn.
      if (ensureGjcTranscriptOwner(stored)) return true;
      console.warn(`[GJC] Cannot resume ${providerSessionId}: its transcript is owned by another user.`);
      return false;
    }
    const found = findGjcTranscript(getGjcLiveSessionRoot(), providerSessionId)
      ?? findGjcTranscript(join(homedir(), '.gjc', 'agent', 'sessions'), providerSessionId);
    if (!found) return false;
    if (!ensureGjcTranscriptOwner(found)) {
      console.warn(`[GJC] Cannot resume ${providerSessionId}: its transcript is owned by another user.`);
      return false;
    }
    // The row still names the old location, so the resumed run would resolve
    // the wrong session root. Repointing it also keeps later turns cheap.
    if (session && found !== stored) sessionsDb.updateSessionJsonlPath(session.session_id, found);
    return true;
  } catch {
    // An unreadable store is not proof the history is gone; keep resuming.
    return true;
  }
}

export async function resolveGjcResumeSessionRoot(
  sessionId: string,
  liveSessionRoot: string,
  lookup: GjcSessionPathLookup = sessionJsonlPath,
): Promise<string | undefined> {
  try {
    const sessionPath = await realpath(await lookup(sessionId) ?? '');
    const sessionDirectory = dirname(sessionPath);
    const roots = [
      join(homedir(), '.gjc', 'agent', 'sessions'),
      liveSessionRoot,
    ];
    for (const root of roots) {
      try {
        const canonicalRoot = await realpath(root);
        // SessionManager.list() scans only the supplied directory. Managed
        // sessions live one level below the global sessions root, so returning
        // that global root makes every historical resume look missing.
        if (containedBy(canonicalRoot, sessionPath)) return sessionDirectory;
      } catch {
        // A missing or inaccessible allowlist root cannot contain a resumable session.
      }
    }
  } catch {
    // Session metadata is advisory; preserve the live-root fallback.
  }
  return undefined;
}

type GjcRunOptionAuthorities = {
  resolveBrowserBackend(): GjcBrowserBackend;
  browserStatus(): Promise<unknown>;
  computerUsable?(): boolean;
  hostControlPolicy?(): HostControlRunPolicy | undefined;
  /** Production reads the session row; tests inject the answer. */
  transcriptExists?(providerSessionId: string): Promise<boolean>;
};

export async function enrichGjcSdkRunOptions(
  options: GjcWorkerOptions,
  injectedAuthorities?: GjcRunOptionAuthorities,
): Promise<GjcWorkerOptions> {
  let modelId = options.modelId ?? options.model;
  let modelProfile = typeof options.modelProfile === 'string' ? options.modelProfile.trim() : '';
  if (typeof modelId === 'string' && modelId.startsWith('profile:')) {
    modelProfile = modelId.slice('profile:'.length).trim();
    modelId = 'default';
  }
  if (modelId === null || modelId === undefined) {
    try {
      const { providerModelsService } = await import('./modules/providers/index.js');
      modelId = (await providerModelsService.getCurrentActiveModel('gjc')).model;
    } catch {
      throw new GjcConfigurationError('Unable to resolve the active GJC model.');
    }
  }
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new GjcConfigurationError('GJC requires a configured model ID.');
  }
  // The browser backend is the app's own setting, read here and never taken
  // from the request, like the permission policy: a client cannot switch a
  // run to Aside by sending an option.
  let browserBackend: GjcBrowserBackend;
  let authorities = injectedAuthorities;
  try {
    if (!authorities) {
      const [{ automationService, resolveGjcBrowserBackend }, hostControl] = await Promise.all([
        import('./modules/automation/index.js'),
        import('./modules/host-control/index.js'),
      ]);
      authorities = {
        resolveBrowserBackend: resolveGjcBrowserBackend,
        browserStatus: () => automationService.browser.status(),
        computerUsable: () => automationService.computerUsable(),
        hostControlPolicy: () => hostControl.readHostControlRunPolicy(),
      };
    }
    browserBackend = authorities.resolveBrowserBackend();
  } catch {
    throw new GjcConfigurationError('Unable to resolve the GJC browser backend.');
  }
  // This is capability evidence from the authenticated native client, not a
  // client preference. A missing or failed status check only removes browser;
  // ordinary self-hosted chat must still be able to start.
  let builtinBrowserAvailable = false;
  try {
    const status = object(await authorities.browserStatus());
    builtinBrowserAvailable = status?.state === 'ready'
      && status.ready === true
      && status.engine === 'webview';
  } catch {
    builtinBrowserAvailable = false;
  }
  // Computer use is the user's Settings switch plus a trusted paired device,
  // both server-owned. A failure here only withholds the tool; chat still
  // starts on a self-hosted server with no companion.
  let computerAvailable = false;
  try {
    computerAvailable = authorities.computerUsable?.() === true;
  } catch {
    computerAvailable = false;
  }
  // Host control is the env gate plus the operator's per-capability switches,
  // both server-owned. A failure here only withholds the host tool.
  let hostControl: HostControlRunPolicy | undefined;
  try {
    hostControl = authorities.hostControlPolicy?.();
  } catch {
    hostControl = undefined;
  }

  // A caller-pinned root (isolated dev, tests) or an explicit env override keeps
  // the old flat store. Otherwise a new session is created in the SDK's managed
  // destination, the directory the GJC CLI's `/resume` scans.
  const pinnedSessionRoot = typeof options.sessionRoot === 'string' && options.sessionRoot
    ? options.sessionRoot
    : process.env.GJC_LIVE_SESSION_DIR ? getGjcLiveSessionRoot() : undefined;
  const managedSessionScope = pinnedSessionRoot === undefined;
  const liveSessionRoot = pinnedSessionRoot ?? getGjcLiveSessionRoot();
  const requestedSessionId = typeof options.sessionId === 'string' && options.sessionId
    ? options.sessionId
    : undefined;
  // Transcripts written before the app used the CLI-visible store sit under the
  // app's own root. Move them before the run so the CLI can list the session
  // too; a refused move leaves the row untouched.
  if (requestedSessionId) {
    await relocateLiveGjcTranscript(requestedSessionId).catch(() => undefined);
  }
  // A conversation whose transcript has vanished (deleted, half-restored
  // backup, wiped volume) can never be resumed: the worker's lookup finds no
  // file, so every send fails and the conversation is stuck forever with a
  // message that names nothing. Start a new provider session in the same
  // conversation instead; the app registers the new id on `session.created`.
  // A transcript that merely moved is repointed first, so its context survives.
  const resumable = requestedSessionId
    ? await (authorities.transcriptExists ?? resumableGjcTranscript)(requestedSessionId)
    : false;
  const sessionRoot = requestedSessionId && resumable
    ? await resolveGjcResumeSessionRoot(requestedSessionId, liveSessionRoot) ?? liveSessionRoot
    : liveSessionRoot;
  const base: GjcWorkerOptions = { ...options };
  if (requestedSessionId && !resumable) delete base.sessionId;
  return {
    ...base,
    cwd: options.cwd ?? options.projectPath,
    sessionRoot,
    managedSessionScope,
    credential: options.credential ?? { kind: 'stored' },
    modelId,
    ...(modelProfile ? { modelProfile } : {}),
    effort: typeof options.effort === 'string' && options.effort ? options.effort : 'default',
    toolNames: options.toolNames ?? [...GJC_AGENT_TOOL_NAMES],
    spawns: options.spawns ?? '*',
    bashPolicy: options.bashPolicy ?? { allowedPrefixes: [] },
    browserBackend,
    // Always overwrite any untrusted request field.
    builtinBrowserAvailable,
    computerAvailable,
    // Always overwrite any untrusted request field.
    hostControl,
  };
}

export function killWorkerTree(
  child: Child,
  platform: NodeJS.Platform = process.platform,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
): Promise<void> {
  if (platform === 'win32') {
    // Windows runtime is frozen in v2; no verified tree-reap implementation exists.
    return Promise.reject(new Error('GJC worker tree reaping is unconfirmed on Windows.'));
  }
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const reapProcessGroup = (): void => {
      try {
        kill(-child.pid!, 'SIGKILL');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // A concurrently exited child cannot prevent process-group verification.
      }
    };
    const verifyProcessGroup = (): void => {
      if (settled) return;
      if (!child.pid) {
        if (closed) finish();
        return;
      }
      try {
        reapProcessGroup();
        kill(-child.pid, 0);
        setTimeout(verifyProcessGroup, 25);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          if (closed) finish();
          else setTimeout(verifyProcessGroup, 25);
        } else if (code === 'EPERM') {
          setTimeout(verifyProcessGroup, 25);
        } else {
          finish(new Error('GJC worker process group termination could not be verified.', { cause: error }));
        }
      }
    };
    child.on('close', () => {
      closed = true;
      verifyProcessGroup();
    });
    const timer = setTimeout(() => finish(new Error('GJC worker tree termination timed out.')), 5_000);
    timer.unref?.();
    try {
      if (child.pid) {
        try {
          kill(-child.pid, 'SIGKILL');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH' && code !== 'EPERM') throw error;
          try {
            child.kill('SIGKILL');
          } catch {
            // A concurrently exited child cannot prevent process-group verification.
          }
        }
      } else if (!child.kill('SIGKILL')) {
        throw new Error('GJC worker process could not be terminated.');
      }
      verifyProcessGroup();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('GJC worker tree termination failed.'));
    }
  });
}

/** Supervises the private Protocol v1 worker while preserving app-owned lifecycle state. */
export class GjcWorkerSupervisor {
  private readonly runtime: Required<Pick<GjcWorkerSupervisorRuntime, 'spawn' | 'initializeTimeoutMs' | 'shutdownTimeoutMs' | 'requestTimeoutMs' | 'createScope' | 'diagnostic' | 'notifyRunStopped' | 'notifyRunFailed' | 'killTree' | 'killProcessTree' | 'platform' | 'environment' | 'enrichOptions'>> & Pick<GjcWorkerSupervisorRuntime, 'corePath' | 'workerPath' | 'compiled' | 'bunPath' | 'allowDevelopmentBun'>;
  private child?: Child;
  private ready = false;
  private starting?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private terminating?: Promise<void>;
  private terminatingGeneration?: { child: Child; runIds: ReadonlySet<string>; outcome: Promise<GjcWorkerReapOutcome> };
  private terminationFailure?: Error;
  private decoder?: GjcWorkerNdjsonDecoder;
  private recentWorkerOutput = '';
  private generationFailure?: string;
  private tracker = new GjcWorkerRequestTracker();
  private readonly runs = new Map<string, Run>();
  private readonly aliases = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly expiredRequests = new Map<string, ExpiredRequest>();
  private readonly oauthListeners = new Set<GjcWorkerOAuthListener>();
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0n;
  private readonly activityTasks = { starting: 0, settling: 0 };
  private readonly unreapedWorkers = new Set<Child>();
  private requestTimeoutUncertainty = false;
  private readonly reapingWorkers = new Set<Child>();
  private runProcessProofMissing = false;
  private readonly hasRunProcessReaper: boolean;
  private desktopAdmission?: GjcWorkerDesktopAdmission;
  private restartFence?: {
    id: string; child?: Child; acknowledged: boolean; pending?: Promise<void>;
    /** Immutable first correlated observation for this exact acknowledged fence. */
    remoteGeneration?: string;
    invalidated?: boolean;
  };
  private observation?: {
    id: string; child: Child; promise: Promise<WorkerActivityObservation | undefined>;
    settle(value?: WorkerActivityObservation): void;
  };

  constructor(runtime: GjcWorkerSupervisorRuntime = {}) {
    this.hasRunProcessReaper = runtime.killProcessTree !== undefined;
    this.runtime = {
      spawn: runtime.spawn ?? spawnChild as unknown as Spawn,
      corePath: runtime.corePath,
      workerPath: runtime.workerPath,
      compiled: runtime.compiled,
      bunPath: runtime.bunPath,
      allowDevelopmentBun: runtime.allowDevelopmentBun ?? process.env.GAJAE_ALLOW_DEVELOPMENT_BUN === '1',
      enrichOptions: runtime.enrichOptions ?? (async (options) => options),
      initializeTimeoutMs: runtime.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      shutdownTimeoutMs: runtime.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      requestTimeoutMs: runtime.requestTimeoutMs ?? 30_000,
      createScope: runtime.createScope ?? (() => `gjc-${randomUUID()}`),
      diagnostic: runtime.diagnostic ?? (() => {}),
      notifyRunStopped: runtime.notifyRunStopped ?? notifyRunStopped as unknown as RunStoppedNotifier,
      notifyRunFailed: runtime.notifyRunFailed ?? notifyRunFailed as unknown as RunFailedNotifier,
      killTree: runtime.killTree ?? ((child) => killWorkerTree(child, runtime.platform ?? process.platform)),
      killProcessTree: runtime.killProcessTree ?? (() => {}),
      platform: runtime.platform ?? process.platform,
      environment: runtime.environment ?? process.env,
    };
  }

  /** Pure revision; unique across supervisors and never reused after an idle/busy/idle cycle. */
  getGeneration(): string {
    return `${this.activityEpoch}:${this.activityRevision}`;
  }

  configureDesktopRestartAdmission(admission?: GjcWorkerDesktopAdmission): void {
    this.desktopAdmission = admission;
  }

  private acquireRoot(source: string): () => void {
    if (this.restartFence) throw Object.assign(new Error('Worker admission is fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    const lease = this.desktopAdmission?.acquire(`gjc-worker:${source}`);
    return () => lease?.release();
  }

  /** Close locally before any await. Busy accepted roots keep running; never abort to fence. */
  async fenceForDesktopRestart(fenceId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fenceId)) throw new TypeError('Invalid worker fence.');
    if (this.restartFence && this.restartFence.id !== fenceId) throw new Error('Worker fence conflicts.');
    if (!this.restartFence) {
      this.restartFence = { id: fenceId, acknowledged: false };
      this.activityChanged();
    }
    const fence = this.restartFence;
    if (fence.pending) return fence.pending;
    if (fence.acknowledged && fence.child === this.child) return;
    // These operations were accepted before close. They can still deliver
    // their original request, so do not place a remote fence in their path.
    if (this.starting || this.runs.size || this.tracker.size || this.activityTasks.starting || this.activityTasks.settling) {
      throw new Error('Worker has accepted work.');
    }
    const child = this.child;
    if (!child) {
      if (this.unreapedWorkers.size || this.terminating || this.terminationFailure) throw new Error('Worker ownership is unconfirmed.');
      fence.acknowledged = true;
      return;
    }
    if (!this.ready) throw new Error('Worker is not ready.');
    fence.child = child;
    const pending = this.request('worker.admission', undefined, { fenceId, closed: true }, 1_000).then((response) => {
      if (!response.ok || object(response.result)?.fenceId !== fenceId || this.child !== child || this.restartFence !== fence) {
        throw new Error('Worker fence was not acknowledged.');
      }
      fence.acknowledged = true;
      this.activityChanged();
    }).finally(() => { if (fence.pending === pending) fence.pending = undefined; });
    fence.pending = pending;
    return pending;
  }

  /** Exact-ID release; failed/late acknowledgement leaves local admission closed. */
  async releaseDesktopRestartFence(fenceId: string): Promise<void> {
    const fence = this.restartFence;
    if (!fence) return;
    if (fence.id !== fenceId) throw new Error('Worker fence conflicts.');
    try { await fence.pending; } catch { /* Still send ordered release to the same child. */ }
    if (fence.child && fence.child === this.child) {
      const response = await this.request('worker.admission', undefined, { fenceId, closed: false }, 1_000);
      if (!response.ok || object(response.result)?.fenceId !== null) throw new Error('Worker fence release was not acknowledged.');
    }
    if (this.restartFence === fence) {
      this.restartFence = undefined;
      this.activityChanged();
    }
  }

  /** Observes the existing child only. Never calls ensureWorker, cancellation or reaping. */
  async readDesktopRestartActivity(): Promise<DesktopOwnerActivity> {
    const initial = this.snapshotActivity();
    const child = this.child;
    if (!child || !this.ready || this.terminating || this.terminationFailure) return initial;
    const fence = this.restartFence;
    const remote = await this.observeWorker(child);
    const changed = this.getGeneration() !== initial.generation || this.child !== child || this.restartFence !== fence;
    if (!remote || changed || remote.fenceId !== (fence?.id ?? null)) {
      return { ...initial, complete: false, unknown: [...new Set([...initial.unknown,
        !remote ? 'worker_observation_unavailable' : 'worker_observation_stale'])] };
    }
    if (fence?.acknowledged && fence.child === child) {
      if (fence.remoteGeneration === undefined) {
        // Establishing evidence is not new activity: the first observation
        // must still match the synchronous generation captured by authority.
        fence.remoteGeneration = remote.generation;
      } else if (fence.remoteGeneration !== remote.generation && !fence.invalidated) {
        // An actual remote mutation invalidates every prepared proof under
        // this fence. Never silently rebase it to a newer (or reverted) idle
        // revision. Release + a new fence is the only way to establish proof.
        fence.invalidated = true;
        this.activityChanged();
      }
    }
    // Account for this child through evidence without forgetting its OS owner.
    // Other unreaped generations, escaped PIDs and timeout latches stay unknown.
    const unknown = [...new Set([
      ...initial.unknown.filter((reason) => reason !== 'worker_runtime_unaccounted'
        || this.unreapedWorkers.size !== 1 || this.runProcessProofMissing || this.runtime.platform === 'win32'),
      ...remote.unknown,
      ...(!fence?.acknowledged || fence.child !== child ? ['worker_admission_open'] : []),
      ...(fence?.invalidated ? ['worker_observation_stale'] : []),
    ])].slice(0, 32);
    return {
      ...initial, complete: remote.complete && unknown.length === 0,
      starting: initial.starting + remote.starting,
      queued: initial.queued + remote.queued,
      running: initial.running + remote.running,
      settling: initial.settling + remote.settling,
      approvals: initial.approvals + remote.approvals,
      retained: initial.retained - Number(this.runtime.platform !== 'win32') + remote.retained,
      unknown,
    };
  }

  private observeWorker(child: Child): Promise<WorkerActivityObservation | undefined> {
    // One slot per child, including a timed-out request awaiting its late reply.
    // Repeated reads cannot accumulate requests, timers or expired-ID entries.
    if (this.observation?.child === child) return this.observation.promise;
    const id = `observe-${randomUUID()}`;
    let settle!: (value?: WorkerActivityObservation) => void;
    const promise = new Promise<WorkerActivityObservation | undefined>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => settle(), 250);
    timer.unref?.();
    const observation = { id, child, promise, settle: (value?: WorkerActivityObservation) => { clearTimeout(timer); settle(value); } };
    this.observation = observation;
    try {
      child.stdin.write(serializeGjcWorkerFrame({ protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
        kind: 'request', id, method: 'worker.activity', payload: {} }));
    } catch { observation.settle(); }
    return promise;
  }

  /**
   * Pure parent-side accounting. A retained live child is unaccounted here;
   * readDesktopRestartActivity can compose fenced worker evidence without
   * forgetting that OS owner. Counts overlap and include app continuations
   * after a request/run is removed.
   */
  snapshotActivity(): DesktopOwnerActivity {
    let registered = 0;
    let running = 0;
    let aborting = 0;
    let approvalsInFlight = 0;
    for (const run of this.runs.values()) {
      if (run.phase === 'registered') registered += 1;
      if (run.phase === 'request_issued') running += 1;
      if (run.abortPromise) aborting += 1;
    }
    for (const approval of this.approvals.values()) {
      if (approval.inFlight) approvalsInFlight += 1;
    }
    const unknown: string[] = [];
    if (this.unreapedWorkers.size || this.runProcessProofMissing) unknown.push('worker_runtime_unaccounted');
    if (this.requestTimeoutUncertainty) unknown.push('worker_request_timeout_unconfirmed');
    if (this.reapingWorkers.size) unknown.push('worker_reap_pending');
    if (this.terminationFailure) unknown.push('worker_reap_unconfirmed');
    if (this.runProcessProofMissing) unknown.push('worker_process_tree_unaccounted');
    return {
      owner: 'gjc-worker', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: this.activityTasks.starting + registered,
      queued: this.tracker.size,
      running,
      settling: this.activityTasks.settling + aborting + approvalsInFlight,
      approvals: this.approvals.size,
      retained: this.unreapedWorkers.size + Number(this.runProcessProofMissing),
      unknown,
    };
  }

  private activityChanged(): void {
    this.activityRevision += 1n;
  }

  /** Covers awaits and synchronous user callbacks that can outlive map entries. */
  private beginActivity(kind: keyof GjcWorkerSupervisor['activityTasks']): () => void {
    this.activityTasks[kind] += 1;
    this.activityChanged();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activityTasks[kind] -= 1;
      this.activityChanged();
    };
  }
  /**
   * Sends a global OAuth request through the one supervised worker. OAuth
   * protocol requests deliberately carry no app session id.
   */
  private async oauthRequest(
    method: GjcWorkerOAuthRequestMethod,
    payload: JsonObject,
  ): Promise<GjcWorkerResponsePayload> {
    const releaseAdmission = method === 'oauth.submit' || method === 'oauth.cancel' ? () => {} : this.acquireRoot(method);
    const release = this.beginActivity('settling');
    try {
      if (this.restartFence && (!this.child || !this.ready)) throw new Error('No accepted OAuth attempt is available.');
      await this.ensureWorker();
      return await this.request(method, undefined, payload);
    } finally {
      release();
      releaseAdmission();
    }
  }

  async modelCatalog(): Promise<GjcWorkerResponsePayload> {
    const releaseAdmission = this.acquireRoot('models.catalog');
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      return await this.request('models.catalog', undefined, {});
    } finally {
      release();
      releaseAdmission();
    }
  }

  /** Reads normalized, credential-free provider quota from the owned worker. */
  async providerQuota(): Promise<GjcWorkerResponsePayload> {
    const releaseAdmission = this.acquireRoot('quota.providers');
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      return await this.request('quota.providers', undefined, {});
    } finally {
      release();
      releaseAdmission();
    }
  }

  async inspectGoal(scope: GjcGoalScope, providerSessionId: string): Promise<GjcGoalSnapshot> {
    const releaseAdmission = this.acquireRoot('goal.inspect');
    const release = this.beginActivity('settling');
    try {
      const liveRoot = getGjcLiveSessionRoot();
      const sessionRoot = await resolveGjcResumeSessionRoot(providerSessionId, liveRoot) ?? liveRoot;
      await this.ensureWorker();
      const response = await this.request('goal.inspect', scope.appSessionId, { owner: scope.owner, cwd: scope.cwd, ...(scope.projectPath ? { projectPath: scope.projectPath } : {}), providerSessionId, sessionRoot });
      if (!response.ok) throw new Error(response.error.message);
      return response.result as GjcGoalSnapshot;
    } finally {
      release();
      releaseAdmission();
    }
  }

  /** Native whole-session fork; resolves to the new provider session id. */
  forkSession(scope: GjcGoalScope, providerSessionId: string): Promise<GjcBranchedSession> {
    return this.#branchSession('session.fork', scope, providerSessionId, {});
  }

  /** Branches the session at one entry, the headless form of `/tree`. */
  branchSession(scope: GjcGoalScope, providerSessionId: string, entryId: string): Promise<GjcBranchedSession> {
    return this.#branchSession('session.branch', scope, providerSessionId, { entryId });
  }

  /** Repoints the session cwd through the SDK's `/move` transition. */
  async moveSession(scope: GjcGoalScope, providerSessionId: string, cwd: string): Promise<{ cwd: string; transcriptPath: string }> {
    const releaseAdmission = this.acquireRoot('session.move');
    const release = this.beginActivity('settling');
    try {
      const liveRoot = getGjcLiveSessionRoot();
      const sessionRoot = await resolveGjcResumeSessionRoot(providerSessionId, liveRoot) ?? liveRoot;
      await this.ensureWorker();
      const response = await this.request('session.move', scope.appSessionId, { providerSessionId, sessionRoot, cwd });
      if (!response.ok) throw new Error(response.error.message);
      const result = response.result as { cwd?: unknown; transcriptPath?: unknown } | undefined;
      if (!result || typeof result.cwd !== 'string' || typeof result.transcriptPath !== 'string') {
        throw new Error('The worker returned no moved session.');
      }
      return { cwd: result.cwd, transcriptPath: result.transcriptPath };
    } finally {
      release();
      releaseAdmission();
    }
  }

  async #branchSession(
    method: 'session.fork' | 'session.branch',
    scope: GjcGoalScope,
    providerSessionId: string,
    extra: JsonObject,
  ): Promise<GjcBranchedSession> {
    const releaseAdmission = this.acquireRoot(method);
    const release = this.beginActivity('settling');
    try {
      const liveRoot = getGjcLiveSessionRoot();
      const sessionRoot = await resolveGjcResumeSessionRoot(providerSessionId, liveRoot) ?? liveRoot;
      await this.ensureWorker();
      const response = await this.request(method, scope.appSessionId, { providerSessionId, sessionRoot, ...extra });
      if (!response.ok) throw new Error(response.error.message);
      const result = response.result as { sessionId?: unknown; transcriptPath?: unknown } | undefined;
      if (!result || typeof result.sessionId !== 'string' || typeof result.transcriptPath !== 'string') {
        throw new Error('The worker returned no branched session.');
      }
      return { sessionId: result.sessionId, transcriptPath: result.transcriptPath };
    } finally {
      release();
      releaseAdmission();
    }
  }

  async controlGoal(runId: string, scope: GjcGoalScope, command?: GjcGoalCommand, stopAfterMutation = true): Promise<GjcGoalSnapshot> {
    const run = this.runs.get(runId);
    if (!run || run.appScope !== scope.appSessionId || run.phase !== 'request_issued' || run.aborted || run.abortPromise) throw new Error('The active run changed. Refresh before controlling its goal.');
    const release = this.beginActivity('settling');
    try {
      const response = await this.request('goal.control', scope.appSessionId, {
        runId, owner: scope.owner, cwd: scope.cwd, ...(scope.projectPath ? { projectPath: scope.projectPath } : {}), ...(command ? { command } : {}),
        ...(stopAfterMutation ? {} : { stopAfterMutation: false }),
      });
      if (!response.ok) throw new Error(response.error.message);
      return response.result as GjcGoalSnapshot;
    } finally {
      release();
    }
  }

  oauthProviders(): Promise<GjcWorkerResponsePayload> {
    return this.oauthRequest('oauth.providers', {});
  }

  oauthStatus(): Promise<GjcWorkerResponsePayload> {
    return this.oauthRequest('oauth.status', {});
  }

  oauthStart(providerId: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(providerId)) return Promise.resolve(oauthFailure('invalid_payload'));
    return this.oauthRequest('oauth.start', { providerId });
  }

  async oauthSubmit(attemptId: string, value: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(attemptId) || typeof value !== 'string') {
      return oauthFailure('invalid_payload');
    }
    if (value.length > GJC_OAUTH_SUBMIT_MAX_LENGTH) {
      return oauthFailure('oauth_submit_too_large');
    }

    const payload: JsonObject = { attemptId, value };
    try {
      return await this.oauthRequest('oauth.submit', payload);
    } finally {
      // The serialized frame has already been written; do not retain input in
      // request tracking after the worker receives it.
      payload.value = '';
      value = '';
    }
  }

  oauthCancel(attemptId: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(attemptId)) return Promise.resolve(oauthFailure('invalid_payload'));
    return this.oauthRequest('oauth.cancel', { attemptId });
  }

  subscribeOAuth(listener: GjcWorkerOAuthListener): () => void {
    this.oauthListeners.add(listener);
    return () => this.oauthListeners.delete(listener);
  }

  private emitOAuthEvent(event: GjcWorkerOAuthEvent): void {
    this.activityChanged();
    for (const listener of this.oauthListeners) {
      try {
        listener(event);
      } catch {
        this.diagnose('OAuth event listener failed.');
      }
    }
  }


  private diagnose(message: string): void {
    try {
      this.runtime.diagnostic(message);
    } catch {
      // Diagnostics must never interfere with worker lifecycle handling.
    }
  }

  private invokeAppCallback(label: string, callback: () => unknown): void {
    const release = this.beginActivity('settling');
    try {
      void Promise.resolve(callback()).catch(() => this.diagnose(label)).finally(release);
    } catch {
      this.diagnose(label);
      release();
    }
  }

  spawnRun(input: GjcWorkerSpawnRun): GjcWorkerRun {
    const { runId, appSessionId, message, options = {}, writer } = input;
    if (!safeId(runId) || !safeId(appSessionId) || this.runs.has(runId) || this.shuttingDown) {
      const error = new Error(SAFE_FAILURE);
      const started = Promise.reject(error);
      const completion = Promise.reject(error);
      void started.catch(() => {});
      void completion.catch(() => {});
      return { started, completion, outcome: Promise.resolve('not_started'), abortHandle: runId };
    }
    let resolve!: () => void; let reject!: (error: Error) => void;
    let resolveOutcome!: (outcome: GjcWorkerOutcome) => void;
    let resolveStarted!: () => void; let rejectStarted!: (error: Error) => void;
    const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const outcome = new Promise<GjcWorkerOutcome>((res) => { resolveOutcome = res; });
    void completion.catch(() => {});
    const started = new Promise<void>((res, rej) => { resolveStarted = res; rejectStarted = rej; });
    void started.catch(() => {});
    const run: Run = {
      runId, appScope: appSessionId, writer, options, aborted: false, phase: 'registered',
      terminalForwarded: false, terminalFailed: false, resolve, reject,
      resolveOutcome, resolveStarted, rejectStarted, started: false,
    };
    this.runs.set(runId, run);
    this.activityChanged();
    let releaseAdmission: () => void;
    try { releaseAdmission = this.acquireRoot('session.start'); }
    catch (error) {
      this.runs.delete(runId);
      this.activityChanged();
      rejectStarted(error as Error); reject(error as Error); resolveOutcome('not_started');
      return { started, completion, outcome, abortHandle: runId };
    }
    void this.startRun(run, message).finally(releaseAdmission);
    return { started, completion, outcome, phase: () => run.phase, abortHandle: runId };
  }

  private canStartRun(run: Run, startingChild: Child | undefined): boolean {
    // A cancelled/reaped run may have been removed and its ID reused while
    // startup or model/session-root enrichment was awaiting external work.
    if (this.runs.get(run.runId) !== run || run.phase !== 'registered') return false;
    if (run.aborted || this.shuttingDown) {
      // Exact identity + registered phase select abort's existing synchronous
      // not_started path. Its notification promises retain their own lifetime.
      void this.abort(run.runId);
      return false;
    }
    // Bind to the Child, not the activity revision (ordinary events change it).
    // If its generation is being reaped, workerFailed still owns settlement.
    return Boolean(startingChild && this.child === startingChild && this.ready
      && !this.terminating && !this.terminationFailure && !run.cleanupUnconfirmed && !run.abortPromise);
  }

  private async startRun(run: Run, message: string): Promise<void> {
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      const startingChild = this.child;
      if (!this.canStartRun(run, startingChild)) return;

      const requestedSessionId = safeId(run.options.sessionId);
      if (requestedSessionId) {
        run.providerSessionId = requestedSessionId;
        this.aliases.set(requestedSessionId, run.runId);
        this.activityChanged();
      }

      const enriched = await this.runtime.enrichOptions(run.options);
      // Enrichment may refuse to resume (the transcript the app points at is
      // gone); the run must start a new provider session instead of asking the
      // worker to reopen a file that no longer exists.
      const providerSessionId = safeId(enriched.sessionId) ? requestedSessionId : undefined;
      if (!providerSessionId && requestedSessionId) {
        this.aliases.delete(requestedSessionId);
        run.providerSessionId = undefined;
        this.activityChanged();
      }
      const options = safeOptions(enriched);
      // No await between the final ownership check and writing the request.
      if (!this.canStartRun(run, startingChild)) return;
      if (!options) {
        this.finish(run, true, SAFE_FAILURE, 'not_started');
        return;
      }

      const payload: JsonObject = {
        message,
        options,
        ...(providerSessionId ? { providerSessionId } : {}),
      };
      const method = providerSessionId ? 'session.resume' : 'session.start';
      const response = await this.request(
        method,
        run.appScope,
        payload,
        null,
        run.runId,
        () => {
          run.phase = 'request_issued';
          run.started = true;
          this.activityChanged();
          run.resolveStarted();
        },
      );
      if (response.ok && object(response.result)?.aborted === true) {
        // Goal limits can stop inside the worker without an app turn.abort.
        // Preserve that outcome through native jobs and the chat terminal.
        run.runtimeAborted = !run.aborted && !run.abortPromise;
        run.aborted = true;
        this.activityChanged();
      }
      // A forwarded failed terminal is the run's failure even when the start
      // response was successful: a usage limit resolves the runtime's promise
      // while the turn has already failed, and the generic text blamed a
      // worker that was healthy.
      this.finish(
        run,
        run.terminalFailed || !response.ok,
        run.terminalFailed && response.ok ? RUN_FAILED : runFailureMessage(response),
      );
    } catch (error) {
      // workerFailed owns terminal settlement for a run whose request reached
      // the worker; a run that never started is settled here, even while a reap
      // is still in flight, or an unconfirmed reap strands its promise forever.
      if (run.phase === 'request_issued' && (this.terminating || this.terminationFailure)) return;
      this.finish(
        run,
        true,
        error instanceof GjcConfigurationError ? error.message : SAFE_FAILURE,
      );
    } finally {
      release();
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.terminationFailure) return Promise.reject(this.terminationFailure);
    if (this.terminating) {
      return this.terminating.then(() => this.ensureWorker());
    }
    if (this.ready && this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    const release = this.beginActivity('starting');
    try {
      return this.startWorker(release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private startWorker(releaseStartup: () => void): Promise<void> {
    const compiled = this.runtime.compiled ?? !import.meta.url.endsWith('.ts');
    const workerPath = this.runtime.workerPath ?? fileURLToPath(new URL(compiled ? './gjc-bun-worker.js' : './gjc-bun-worker.ts', import.meta.url));
    const bundledBunPath = fileURLToPath(new URL(
      compiled ? '../../dist-native/bun' : '../dist-native/bun',
      import.meta.url,
    ));
    const bunPath = this.runtime.bunPath
      ?? (existsSync(bundledBunPath) ? bundledBunPath : undefined)
      ?? (!compiled && this.runtime.allowDevelopmentBun ? 'bun' : undefined);
    if (!bunPath) throw new Error(SAFE_FAILURE);
    const coreExecutable = this.runtime.platform === 'win32'
      ? 'gajae-core.exe'
      : 'gajae-core';
    const corePath = this.runtime.corePath ?? fileURLToPath(new URL(
      compiled
        ? `../../dist-native/${coreExecutable}`
        : `../dist-native/${coreExecutable}`,
      import.meta.url,
    ));
    const coreArgs = ['--', bunPath, workerPath];
    // The worker runs the agent's own `bash`, so it must not carry the keys
    // that authenticate a caller to this server (see child-environment.ts).
    // The app is the only notification sender for its own sessions (desktop,
    // web push, Telegram in notification-orchestrator). The SDK's managed
    // Telegram/Discord/Slack adapters would deliver a second copy of the same
    // run, so app-spawned workers are held out of automatic admission. A
    // terminal started from the app inherits this and stays silent too.
    const workerEnv = {
      ...childEnvironment(this.runtime.environment),
      GJC_WORKER_AGENT_DIR: this.runtime.environment.GJC_WORKER_AGENT_DIR ?? join(homedir(), '.gjc', 'agent'),
      // In daemon mode the session must be eligible for the CLI's notification
      // daemon; in app mode it stays opted out so both never send.
      GJC_NOTIFICATIONS: workerNotificationsEnv(this.runtime.environment),
    };
    const launch = this.runtime.platform === 'win32'
      ? createWindowsJobLaunch(
          corePath,
          coreArgs,
          workerEnv,
          process.cwd(),
        )
      : {
          command: corePath,
          args: coreArgs,
          env: workerEnv,
        };
    const child = this.runtime.spawn(launch.command, launch.args, {
      detached: this.runtime.platform !== 'win32',
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child; this.ready = false; this.decoder = new GjcWorkerNdjsonDecoder();
    this.recentWorkerOutput = '';
    this.generationFailure = undefined;
    this.unreapedWorkers.add(child);
    this.activityChanged();
    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    let guardSettled = !usesWindowsJobGuard;
    let guardBuffer = Buffer.alloc(0);
    let resolveGuard!: () => void;
    let rejectGuard!: (error: Error) => void;
    const guardReady = usesWindowsJobGuard
      ? new Promise<void>((resolve, reject) => {
          resolveGuard = resolve;
          rejectGuard = reject;
        })
      : Promise.resolve();
    let guardTimer: NodeJS.Timeout | undefined;
    const settleGuard = (error?: Error): void => {
      if (guardSettled) return;
      guardSettled = true;
      this.activityChanged();
      if (guardTimer) clearTimeout(guardTimer);
      if (error) rejectGuard(error);
      else resolveGuard();
    };
    if (usesWindowsJobGuard) {
      guardTimer = setTimeout(() => {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
      }, this.runtime.initializeTimeoutMs);
      guardTimer.unref?.();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (guardSettled) {
        this.onStdout(child, chunk);
        return;
      }
      guardBuffer = Buffer.concat([guardBuffer, chunk]);
      if (guardBuffer.length > 128) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      const newline = guardBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const prelude = guardBuffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
      const remaining = guardBuffer.subarray(newline + 1);
      guardBuffer = Buffer.alloc(0);
      if (prelude !== GJC_WINDOWS_JOB_GUARD_READY) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      try {
        child.stdin.write(`${GJC_WINDOWS_JOB_GUARD_ACK}\n`);
      } catch {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      settleGuard();
      if (remaining.length > 0) this.onStdout(child, remaining);
    });
    const failWorker = (guardedProcessExited = false): void => {
      settleGuard(new Error(SAFE_FAILURE));
      void this.workerFailed(child, guardedProcessExited);
    };
    child.stdin.on('error', () => failWorker());
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.recentWorkerOutput = (this.recentWorkerOutput + text).slice(-2_048);
      this.diagnose(text);
    });
    child.on('error', () => failWorker());
    child.on('exit', (code?: number | null, signal?: NodeJS.Signals | null) => {
      this.diagnoseWorkerExit(child, code ?? null, signal ?? null);
      failWorker(true);
    });
    child.on('close', () => failWorker(true));
    const starting = guardReady
      .then(() => this.request(
        'worker.initialize',
        undefined,
        {},
        this.runtime.initializeTimeoutMs,
      ))
      .then((response) => {
        if (child !== this.child) throw new Error('worker generation was replaced during initialization');
        if (!response.ok) throw new Error(`worker.initialize was rejected (${response.error.code})`);
        this.ready = true;
        this.activityChanged();
      })
      .catch((error: unknown) => {
        // Callers only ever see the sanitized failure; this line is the one
        // record of why a worker never came up (typically the bootstrap
        // outlasting initializeTimeoutMs).
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnose(`GJC worker initialization failed after ${this.runtime.initializeTimeoutMs}ms bound: ${reason}`);
        this.generationFailure = WORKER_NOT_STARTED;
        this.workerFailed(child);
        throw new GjcConfigurationError(WORKER_NOT_STARTED);
      })
      .finally(() => {
        if (this.starting === starting) {
          this.starting = undefined;
          this.activityChanged();
        }
        releaseStartup();
      });
    this.starting = starting;
    this.activityChanged();
    return starting;
  }

  private request(
    method: GjcWorkerRequestMethod,
    sessionId: string | undefined,
    payload: JsonObject,
    timeout: number | null = this.runtime.requestTimeoutMs,
    id = `req-${randomUUID()}`,
    onWritten?: () => void,
  ): Promise<GjcWorkerResponsePayload> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(SAFE_FAILURE));
    const request: GjcWorkerRequestFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'request',
      id,
      method,
      ...(sessionId ? { sessionId } : {}),
      payload,
    } as GjcWorkerRequestFrame;
    let frame: string;
    try {
      frame = serializeGjcWorkerFrame(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const tracked = this.tracker.track(request);
    this.activityChanged();
    try {
      child.stdin.write(frame);
      onWritten?.();
    } catch {
      void this.workerFailed(child);
    }
    if (timeout === null) return tracked;
    return new Promise<GjcWorkerResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.tracker.reject(
          request.id,
          new Error(REQUEST_TIMEOUT),
        )) {
          // The bounded late-response correlation cache is not a lifetime proof.
          // Even a late OAuth/goal reply cannot account for its SDK continuations.
          // Admission cannot launch SDK work. A timed-out close remains fenced
          // locally until an ordered exact-ID release is acknowledged; it must
          // not manufacture permanent SDK uncertainty after successful release.
          if (method !== 'worker.admission') this.requestTimeoutUncertainty = true;
          this.expiredRequests.set(request.id, {
            method: request.method,
            ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
          });
          if (this.expiredRequests.size > 256) {
            const oldest = this.expiredRequests.keys().next().value;
            if (oldest) this.expiredRequests.delete(oldest);
          }
          this.activityChanged();
        }
      }, timeout);
      timer.unref?.();
      tracked.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private onStdout(child: Child, chunk: Buffer): void {
    if (child !== this.child) return;
    try {
      for (const frame of this.decoder?.push(chunk) ?? []) {
        // A fatal response can retire this generation midway through a batch.
        // Its remaining frames must not publish terminals or satisfy requests.
        if (child !== this.child) break;
        if (frame.kind === 'response') this.handleResponse(frame);
        else if (frame.kind === 'event') this.handleEvent(frame);
        else throw new GjcWorkerProtocolError('unexpected_request', 'Worker emitted a request frame.');
      }
    } catch { this.workerFailed(child); }
  }

  private handleResponse(response: GjcWorkerResponseFrame): void {
    if (response.method === 'worker.activity') {
      const observation = this.observation;
      if (!observation || observation.id !== response.id || observation.child !== this.child) {
        throw new GjcWorkerProtocolError('unknown_response_id', 'Activity response does not match its request.');
      }
      this.observation = undefined;
      observation.settle(response.payload.ok ? response.payload.result : undefined);
      return;
    }
    if (!response.payload.ok && response.payload.error.code === GJC_CLEANUP_UNCONFIRMED_CODE) {
      const child = this.child;
      if (child) {
        for (const run of this.runs.values()) run.cleanupUnconfirmed = true;
        this.activityChanged();
        // Fence synchronously, before settling the request and its startRun
        // continuation. workerFailed owns every terminal after verified reap.
        void this.workerFailed(child);
      }
      return;
    }
    const expired = this.expiredRequests.get(response.id);
    if (!expired) {
      this.tracker.settle(response);
      this.activityChanged();
      return;
    }

    const responseSession = 'sessionId' in response ? response.sessionId : undefined;
    if (expired.method !== response.method || expired.sessionId !== responseSession) {
      throw new GjcWorkerProtocolError(
        'mismatched_response',
        'Late response does not match its expired request.',
      );
    }
    this.expiredRequests.delete(response.id);
    this.activityChanged();
  }

  private handleEvent(event: GjcWorkerEventFrame): void {
    if (
      event.method === 'oauth.phase'
      || event.method === 'oauth.providers.updated'
      || event.method === 'provider.auth.updated'
    ) {
      this.emitOAuthEvent({ method: event.method, payload: event.payload });
      return;
    }
    const payload = object(event.payload);
    const runId = safeId(payload?.runId);
    const run = runId ? this.runs.get(runId) : undefined;
    const scope = 'sessionId' in event ? event.sessionId : undefined;
    if (!run || scope !== run.appScope) return;
    this.activityChanged();

    if (event.method === 'worker.status') {
      const processId = payload?.processId;
      if (processId === null) {
        // A status message dropping a PID is not OS termination proof. Do not
        // forget a process the existing reap path can no longer verify.
        if (run.processId) this.runProcessProofMissing = true;
        run.processId = undefined;
        return;
      }
      if (
        typeof processId === 'number'
        && Number.isSafeInteger(processId)
        && processId > 0
        && processId <= 0x7fffffff
      ) {
        if (!this.hasRunProcessReaper || (run.processId && run.processId !== processId)) {
          this.runProcessProofMissing = true;
        }
        run.processId = processId;
      }
      return;
    }

    const message = payload?.message;
    const messageRecord = object(message);
    if (event.method === 'session.created') {
      const providerSessionId = safeId(payload?.providerSessionId);
      if (providerSessionId) {
        if (
          run.providerSessionId
          && this.aliases.get(run.providerSessionId) === run.runId
        ) {
          this.aliases.delete(run.providerSessionId);
        }
        run.providerSessionId = providerSessionId;
        this.aliases.set(providerSessionId, run.runId);
        try {
          run.writer.setSessionId?.(providerSessionId);
        } catch {
          // A disconnected writer must not break worker lifecycle handling.
        }
      }
    }

    const requestId = safeId(messageRecord?.requestId);
    if (requestId && messageRecord?.kind === 'permission_request') {
      this.approvals.set(requestId, {
        runId: run.runId,
        appScope: run.appScope,
        message,
        inFlight: false,
      });
    }
    if (requestId && messageRecord?.kind === 'permission_cancelled') {
      this.approvals.delete(requestId);
    }

    if (Object.hasOwn(event.payload, 'message')) {
      try {
        run.writer.send(message);
      } catch {
        // The run still needs deterministic terminal cleanup after disconnect.
      }
    }

    if (event.method === 'turn.failed' || event.method === 'turn.completed') {
      run.terminalForwarded = true;
      run.terminalFailed = event.method === 'turn.failed';
      this.activityChanged();
    }
  }

  /**
   * Delivers a message into a run that is still streaming.
   *
   * Resolves false when there is nothing live to steer — an unknown alias, a
   * run that never started, or a runtime without steering — which is the
   * caller's signal to queue the message rather than drop it.
   */
  async steer(alias: string, message: string): Promise<boolean> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const run = runId ? this.runs.get(runId) : undefined;
    // 'request_issued' is the only phase with a turn actually in flight:
    // 'registered' has not reached the worker yet and 'run_terminal' is over.
    if (!run || run.phase !== 'request_issued' || run.aborted || run.abortPromise) return false;

    const release = this.beginActivity('settling');
    try {
      const response = await this.request('turn.steer', run.appScope, {
        runId: run.runId,
        message,
      });
      if (!response.ok) return false;
      return object(response.result)?.steered === true;
    } catch {
      return false;
    } finally {
      release();
    }
  }

  abort(alias: string): Promise<GjcWorkerAbortOutcome> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.phase === 'run_terminal') return Promise.resolve('unconfirmed');
    if (run.abortPromise) return run.abortPromise.then((aborted) => aborted ? 'aborted' : 'unconfirmed');
    if (run.phase === 'registered') {
      run.aborted = true;
      this.activityChanged();
      this.finish(run, false, SAFE_FAILURE, 'not_started');
      return Promise.resolve('not_started');
    }
    const release = this.beginActivity('settling');
    const abortPromise = this.request('turn.abort', run.appScope, {
      runId: run.runId,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.aborted !== true || run.phase === 'run_terminal') return false;
      run.aborted = true;
      this.activityChanged();
      return true;
    }).catch(() => false).finally(() => {
      if (run.abortPromise === abortPromise) {
        run.abortPromise = undefined;
        this.activityChanged();
      }
      release();
    });
    run.abortPromise = abortPromise;
    this.activityChanged();
    return abortPromise.then((aborted) => aborted ? 'aborted' : 'unconfirmed');
  }
  async terminate(alias: string): Promise<GjcWorkerReapOutcome> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const child = this.child;
    if (runId && child && this.runs.has(runId)) return this.workerFailed(child);
    const generation = this.terminatingGeneration;
    if (runId && generation?.runIds.has(runId)) return generation.outcome;
    return 'unconfirmed';
  }

  isActive(alias: string): boolean {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    return Boolean(runId && this.runs.has(runId));
  }

  active(): string[] {
    return [...this.runs.keys()];
  }

  resolveApproval(requestId: string, decision: GjcApprovalDecision): boolean {
    if (!this.child || this.terminating || this.terminationFailure) return false;
    const pending = this.approvals.get(requestId);
    const serializedDecision = safeJsonObject(decision);
    if (!pending || !serializedDecision) return false;
    if (pending.inFlight) return true;
    pending.inFlight = true;
    const release = this.beginActivity('settling');
    void this.request('ask.reply', pending.appScope, {
      runId: pending.runId,
      requestId,
      decision: serializedDecision,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.accepted !== true) {
        this.restoreApproval(requestId, pending);
      }
    }).catch(() => this.restoreApproval(requestId, pending)).finally(release);
    return true;
  }

  private restoreApproval(requestId: string, pending: PendingApproval): void {
    if (this.approvals.get(requestId) !== pending) return;
    const run = this.runs.get(pending.runId);
    if (run?.cleanupUnconfirmed) return;
    if (!run || run.phase === 'run_terminal') {
      this.approvals.delete(requestId);
      this.activityChanged();
      return;
    }

    pending.inFlight = false;
    this.activityChanged();
    try {
      run.writer.send(pending.message);
    } catch {
      // Reconnect replay still exposes the restored app-owned mirror.
    }
  }

  pendingApprovals(appSessionId: string): unknown[] {
    if (!this.child || this.terminating || this.terminationFailure) return [];
    return [...this.approvals.values()]
      .filter((item) => item.appScope === appSessionId && !item.inFlight)
      .map((item) => item.message);
  }

  private finish(run: Run, failed: boolean, failureMessage = SAFE_FAILURE, outcome: GjcWorkerOutcome = run.aborted ? 'aborted' : run.phase === 'registered' ? 'not_started' : 'completed'): void {
    const release = this.beginActivity('settling');
    try {
      this.finishRun(run, failed, failureMessage, outcome);
    } finally {
      release();
    }
  }

  private finishRun(run: Run, failed: boolean, failureMessage: string, outcome: GjcWorkerOutcome): void {
    if (run.phase === 'run_terminal') return;
    if (run.cleanupUnconfirmed) {
      if (outcome !== 'reaped') return;
      // An abort response that raced the fatal fault is not proof that this
      // generation drained. Preserve only terminals verified before the fault.
      if (!run.terminalForwarded) {
        failed = true;
        run.aborted = false;
        run.runtimeAborted = false;
      }
    }
    if (run.processId && outcome !== 'reaped') this.runProcessProofMissing = true;
    run.phase = 'run_terminal';
    this.activityChanged();
    if (!run.started) run.rejectStarted(new Error(failureMessage));
    run.resolveOutcome(outcome);

    this.runs.delete(run.runId);
    if (
      run.providerSessionId
      && this.aliases.get(run.providerSessionId) === run.runId
    ) {
      this.aliases.delete(run.providerSessionId);
    }
    for (const [id, pending] of this.approvals) {
      if (pending.runId === run.runId) this.approvals.delete(id);
    }
    this.activityChanged();

    const sessionId = run.providerSessionId ?? run.appScope;
    if (failed && !run.aborted) {
      if (!run.terminalForwarded) {
        try {
          run.writer.send(createNormalizedMessage({
            kind: 'error',
            content: failureMessage,
            provider: 'gjc',
            sessionId,
          }));
          run.writer.send(createCompleteMessage({
            provider: 'gjc',
            sessionId,
            actualSessionId: sessionId,
            exitCode: 1,
          }));
        } catch {
          // Notification and promise settlement remain authoritative.
        }
      }
      if (run.options.notificationOwner !== 'terminal-adapter') {
        this.invokeAppCallback('GJC failure notification failed.', () => this.runtime.notifyRunFailed({
          userId: run.writer.userId ?? null,
          provider: 'gjc',
          sessionId,
          sessionName: run.options.sessionSummary ?? null,
          error: failureMessage,
        }));
      }
      run.reject(new Error(failureMessage));
      return;
    }

    if ((!run.aborted || run.runtimeAborted) && !run.terminalForwarded) {
      try {
        run.writer.send({ ...createCompleteMessage({
          provider: 'gjc',
          sessionId,
          actualSessionId: sessionId,
          exitCode: 0,
        }), ...(run.runtimeAborted ? { aborted: true } : {}) });
      } catch {
        // Notification and promise settlement remain authoritative.
      }
    }
    if (run.options.notificationOwner !== 'terminal-adapter') {
      this.invokeAppCallback('GJC stop notification failed.', () => this.runtime.notifyRunStopped({
        userId: run.writer.userId ?? null,
        provider: 'gjc',
        sessionId,
        sessionName: run.options.sessionSummary ?? null,
        stopReason: run.aborted ? 'aborted' : 'completed',
      }));
    }
    run.resolve();
  }

  private workerFailed(child: Child, guardedProcessExited = false): Promise<GjcWorkerReapOutcome> {
    const existingGeneration = this.terminatingGeneration;
    if (existingGeneration?.child === child) return existingGeneration.outcome;
    if (child !== this.child) return Promise.resolve('unconfirmed');
    // Retain ownership BEFORE clearing child or calling an injected terminator;
    // callbacks may read the owner synchronously inside killTree().
    const release = this.beginActivity('settling');
    this.reapingWorkers.add(child);
    if (this.observation?.child === child) {
      this.observation.settle();
      this.observation = undefined;
    }
    this.child = undefined;
    this.ready = false;
    this.starting = undefined;
    this.decoder = undefined;
    this.activityChanged();

    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    const affectedRuns = [...this.runs.values()];
    const terminations: Promise<void>[] = [];
    // A tree that was still unwinding when the first kill landed is the common
    // failure. Retrying once keeps it from latching the worker shut for the rest
    // of the server's life, which used to need a restart to clear.
    const attempt = async (label: string, action: () => void | Promise<void>, remaining: number): Promise<void> => {
      try {
        await action();
      } catch (error) {
        if (remaining > 1) return attempt(label, action, remaining - 1);
        this.diagnose(label);
        throw error;
      }
    };
    const terminate = (label: string, action: () => void | Promise<void>): void => {
      terminations.push(attempt(label, action, 2));
    };
    // On frozen v2 Windows, tree reaping is deliberately unverified and fails closed.
    // `guardedProcessExited` cannot establish descendant termination without a tested runtime.
    void guardedProcessExited;
    terminate('GJC worker tree termination failed.', () => this.runtime.killTree(child));
    if (!usesWindowsJobGuard) {
      for (const run of affectedRuns) {
        if (run.processId) terminate('GJC run tree termination failed.', () => this.runtime.killProcessTree(run.processId!));
      }
    }
    const termination = Promise.all(terminations).then(() => {}).catch((error) => {
      // The latch outlives this generation and blocks every later run, so the
      // text has to say that a restart, not a retry, is what clears it.
      this.terminationFailure = new GjcConfigurationError(WORKER_RESTART_BLOCKED, { cause: error });
      this.activityChanged();
      throw this.terminationFailure;
    });
    this.terminating = termination;
    const outcome = termination.then(
      () => {
        // Only this existing successful OS tree-reap barrier can clear the
        // generation's runtime/timeout uncertainty, never failAll/exit/eviction.
        // Lost/unverified separately reported PIDs remain a distinct blocker.
        this.reapingWorkers.delete(child);
        // Windows has no qualified tree-reap contract, including injected hooks.
        if (!usesWindowsJobGuard) this.unreapedWorkers.delete(child);
        // The default no-op run reaper or a discarded PID cannot prove the whole
        // tree gone. Its bounded poison latch survives without retaining every
        // otherwise-reaped Child (and its streams) across later generations.
        if (this.unreapedWorkers.size === 0 && !this.runProcessProofMissing) {
          this.requestTimeoutUncertainty = false;
        }
        this.activityChanged();
        const failure = this.generationFailure ?? SAFE_FAILURE;
        for (const run of affectedRuns) {
          this.finish(run, run.terminalForwarded ? run.terminalFailed : true, failure, 'reaped');
        }
        return 'reaped' as const;
      },
      () => {
        this.reapingWorkers.delete(child);
        this.activityChanged();
        for (const run of affectedRuns) run.resolveOutcome('unconfirmed');
        return 'unconfirmed' as const;
      },
    ).finally(release);
    this.terminatingGeneration = {
      child,
      runIds: new Set(affectedRuns.map((run) => run.runId)),
      outcome,
    };
    this.activityChanged();
    void termination.finally(() => {
      if (this.terminating === termination) {
        this.terminating = undefined;
        this.activityChanged();
      }
    }).catch(() => {});

    this.tracker.failAll(new Error(SAFE_FAILURE));
    this.expiredRequests.clear();
    this.activityChanged();
    return outcome;
  }

  /**
   * Records how the shared worker went away. Its stderr stream alone cannot
   * tell an OOM kill (SIGKILL) from a crash, so a dead worker used to leave no
   * exit status anywhere and every session failed with the same sanitized
   * message. The tail is the worker's own last words, without which the log
   * ends at "GJC worker failed." and nothing else.
   */
  private diagnoseWorkerExit(child: Child, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.shuttingDown || child !== this.child) return;
    this.generationFailure = `${WORKER_EXITED} (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}). Send the message again to restart it.`;
    const tail = this.recentWorkerOutput.split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join(' | ');
    this.diagnose(
      `GJC worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, activeRuns=${this.runs.size})`
      + (tail ? `; last worker output: ${tail}` : '; last worker output: none'),
    );
  }

  private async awaitTermination(): Promise<void> {
    const termination = this.terminating;
    if (termination) await termination;
    if (this.terminationFailure) throw this.terminationFailure;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.activityChanged();
    this.shutdownPromise = this.stopWorker();
    return this.shutdownPromise;
  }

  private async stopWorker(): Promise<void> {
    const release = this.beginActivity('settling');
    try {
      await this.stopWorkerAndReap();
    } finally {
      release();
    }
  }

  private async stopWorkerAndReap(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.awaitTermination();
      return;
    }
    for (const run of this.runs.values()) run.aborted = true;
    this.activityChanged();
    try {
      await this.request(
        'worker.shutdown',
        undefined,
        {},
        this.runtime.shutdownTimeoutMs,
      );
    } catch {
      // Tree termination below remains the shutdown fallback.
    }
    if (child === this.child) await this.workerFailed(child);
    await this.awaitTermination();
  }
}

const WORKER_LOG_MAX_BYTES = 4 * 1024 * 1024;
const workerLogPath = join(homedir(), '.gajae-app', 'logs', 'gjc-worker.log');

/**
 * Persists worker diagnostics (stderr and swallowed run failures) to disk.
 * Protocol responses stay sanitized, so this file is the only place an operator
 * can see why a run reported the generic "GJC worker failed." message.
 */
function appendWorkerDiagnostic(message: string): void {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  try {
    mkdirSync(dirname(workerLogPath), { recursive: true });
    if ((statSync(workerLogPath, { throwIfNoEntry: false })?.size ?? 0) > WORKER_LOG_MAX_BYTES) {
      writeFileSync(workerLogPath, '');
    }
    appendFileSync(workerLogPath, `${new Date().toISOString()} ${text}`);
  } catch {
    // Diagnostics are best-effort and must never affect worker lifecycle handling.
  }
}

const INITIALIZATION_DIAGNOSTIC = /^GJC worker initialization failed/u;
/** A worker that dies (or crashes) is an app-level event too: the sanitized run
 * message is all the chat shows, so the reason must reach the server output. */
const FATAL_WORKER_DIAGNOSTIC = /^GJC worker (?:exited|uncaught exception|unhandled rejection)/u;

/**
 * Worker stderr is file-only (it is noisy: terminal bells, SDK chatter), but a
 * worker that never initialized is an app-level event operators must be able
 * to see in the server output, not just in the log file.
 */
function reportWorkerDiagnostic(message: string): void {
  appendWorkerDiagnostic(message);
  if (INITIALIZATION_DIAGNOSTIC.test(message) || FATAL_WORKER_DIAGNOSTIC.test(message)) console.error(`[GJC] ${message.trimEnd()}`);
}

const supervisor = new GjcWorkerSupervisor({ enrichOptions: enrichGjcSdkRunOptions, diagnostic: reportWorkerDiagnostic });
registerGjcRuntimeModelCatalogLoader(() => supervisor.modelCatalog());
registerGjcRuntimeProviderQuotaLoader(() => supervisor.providerQuota());

/** No lazy spawn, shutdown or admission mutation. A live idle proof needs an explicit fence. */
export function createGjcWorkerDesktopRestartReader(worker: GjcWorkerSupervisor = supervisor): {
  getGeneration(): string;
  read(): Promise<DesktopOwnerActivity>;
} {
  return Object.freeze({
    getGeneration: () => worker.getGeneration(),
    read: () => worker.readDesktopRestartActivity(),
  });
}

export function getGjcWorkerSupervisor(): GjcWorkerSupervisor { return supervisor; }
export function isGjcSessionActive(alias: string) { return supervisor.isActive(alias); }
export function resolveGjcToolApproval(requestId: string, decision: GjcApprovalDecision) { return supervisor.resolveApproval(requestId, decision); }
export function getPendingGjcApprovalsForSession(appSessionId: string) { return supervisor.pendingApprovals(appSessionId); }
export function shutdownGjcWorker() { return supervisor.shutdown(); }
export function spawnGjcRun(message: string, options: GjcWorkerOptions = {}, writer: GjcWorkerWriter): Promise<void> & { abortHandle: string } {
  const runId = `run-${randomUUID()}`;
  const appSessionId = writer.getAppSessionId?.() ?? options.sessionId ?? `gjc-${randomUUID()}`;
  const run = supervisor.spawnRun({ runId, appSessionId, message, options, writer });
  const completion = run.completion as Promise<void> & { abortHandle: string };
  completion.abortHandle = run.abortHandle;
  return completion;
}
export function abortGjcRun(runId: string) { return supervisor.abort(runId); }
/** Delivers a message into a run that is still streaming; false when there is nothing live to steer. */
export function steerGjcRun(runId: string, message: string) { return supervisor.steer(runId, message); }
