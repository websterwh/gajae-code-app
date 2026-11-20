import { appConfigDb } from '@/modules/database/index.js';

import {
  HOST_CAPABILITIES,
  isSshHost,
  isSshUser,
  matchesHostTarget,
  parseSshHostKey,
  parseSshPort,
  parseTargets,
  type HostCapability,
  type HostControlRunPolicy,
  type SshHostTarget,
} from '../../gjc-engine.js';

import { readSshPrivateKey } from './host-control.secrets.js';

/**
 * Host control is opt-in twice over.
 *
 * `GAJAE_HOST_CONTROL` admits the feature at all: without it no route answers
 * anything but "not available", so an image deployed without it cannot be
 * talked into host access by a setting, a request or a container name. The
 * settings below then decide, capability by capability, what the app may do
 * with the socket it was given - and they all start off.
 *
 * SSH is a second transport for the same permissions, not a second permission
 * system: its verbs are answered by the `hostRead` and `hostWrite` switches
 * here, and its private key is stored encrypted (see `host-control.secrets`).
 */
const CONFIG_KEY = 'host.control.v1';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function hostControlAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env.GAJAE_HOST_CONTROL ?? '').trim().toLowerCase());
}

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.GAJAE_DOCKER_SOCKET ?? '').trim();
  return configured || '/var/run/docker.sock';
}

export type HostControlSettings = {
  enabled: boolean;
  /** Container-name globs the reaching capabilities may touch. Empty means none. */
  targets: string[];
  /** The SSH endpoint, entered by hand: there is no default that guesses it right. */
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** The pinned server host key line, `ssh-ed25519 AAAA…`. */
  sshHostKey: string;
  /** Prior authorization for host writes; off means every write asks first. */
  sshWritePreauthorized: boolean;
} & Record<HostCapability, boolean>;

export const DEFAULT_HOST_CONTROL_SETTINGS: HostControlSettings = {
  enabled: false,
  facts: false,
  containers: false,
  restart: false,
  discovery: false,
  docker: false,
  shell: false,
  files: false,
  hostRead: false,
  hostWrite: false,
  targets: [],
  sshHost: '',
  sshPort: 22,
  sshUser: 'root',
  sshHostKey: '',
  sshWritePreauthorized: false,
};

const flag = (value: unknown): boolean => value === true;

const host = (value: unknown): string => (isSshHost(value) ? value : '');
const user = (value: unknown): string => (isSshUser(value) ? value : DEFAULT_HOST_CONTROL_SETTINGS.sshUser);

export function readHostControlSettings(): HostControlSettings {
  const raw = appConfigDb.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_HOST_CONTROL_SETTINGS, targets: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<HostControlSettings> & { targets?: unknown };
    return {
      enabled: flag(parsed.enabled),
      facts: flag(parsed.facts),
      containers: flag(parsed.containers),
      restart: flag(parsed.restart),
      discovery: flag(parsed.discovery),
      docker: flag(parsed.docker),
      shell: flag(parsed.shell),
      files: flag(parsed.files),
      hostRead: flag(parsed.hostRead),
      hostWrite: flag(parsed.hostWrite),
      targets: parseTargets(parsed.targets),
      sshHost: host(parsed.sshHost),
      sshPort: parseSshPort(parsed.sshPort) ?? DEFAULT_HOST_CONTROL_SETTINGS.sshPort,
      sshUser: user(parsed.sshUser),
      sshHostKey: parseSshHostKey(parsed.sshHostKey) ?? '',
      sshWritePreauthorized: flag(parsed.sshWritePreauthorized),
    };
  } catch {
    return { ...DEFAULT_HOST_CONTROL_SETTINGS, targets: [] };
  }
}

/** The settings transition on its own, so it can be tested without a database. */
export function applyHostControlPatch(
  current: HostControlSettings,
  patch: Partial<HostControlSettings>,
): HostControlSettings {
  const next: HostControlSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    facts: typeof patch.facts === 'boolean' ? patch.facts : current.facts,
    containers: typeof patch.containers === 'boolean' ? patch.containers : current.containers,
    restart: typeof patch.restart === 'boolean' ? patch.restart : current.restart,
    discovery: typeof patch.discovery === 'boolean' ? patch.discovery : current.discovery,
    docker: typeof patch.docker === 'boolean' ? patch.docker : current.docker,
    shell: typeof patch.shell === 'boolean' ? patch.shell : current.shell,
    files: typeof patch.files === 'boolean' ? patch.files : current.files,
    hostRead: typeof patch.hostRead === 'boolean' ? patch.hostRead : current.hostRead,
    hostWrite: typeof patch.hostWrite === 'boolean' ? patch.hostWrite : current.hostWrite,
    targets: patch.targets === undefined ? [...current.targets] : parseTargets(patch.targets),
    // The address and the pinned host key are settings, not permissions: turning
    // host control off must not make the operator paste a key again. Everything
    // that grants access does drop.
    sshHost: patch.sshHost === undefined ? current.sshHost : host(patch.sshHost),
    sshPort: patch.sshPort === undefined
      ? current.sshPort
      : parseSshPort(patch.sshPort) ?? current.sshPort,
    sshUser: patch.sshUser === undefined ? current.sshUser : user(patch.sshUser),
    sshHostKey: patch.sshHostKey === undefined
      ? current.sshHostKey
      : parseSshHostKey(patch.sshHostKey) ?? current.sshHostKey,
    sshWritePreauthorized: typeof patch.sshWritePreauthorized === 'boolean'
      ? patch.sshWritePreauthorized
      : current.sshWritePreauthorized,
  };
  // A capability never outlives the master switch. Turning host control off
  // drops every permission with it, so turning it back on can never silently
  // restore a restart permission the operator had already switched off - and
  // the target scope and the write pre-authorization go with them, so the next
  // enable starts from nothing.
  if (!next.enabled) {
    next.facts = false;
    next.containers = false;
    next.restart = false;
    next.discovery = false;
    next.docker = false;
    next.shell = false;
    next.files = false;
    next.hostRead = false;
    next.hostWrite = false;
    next.targets = [];
    next.sshWritePreauthorized = false;
  }
  return next;
}

export function writeHostControlSettings(patch: Partial<HostControlSettings>): HostControlSettings {
  const next = applyHostControlPatch(readHostControlSettings(), patch);
  appConfigDb.set(CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** The one place that decides whether a capability is in force. */
export function allowsHostCapability(settings: HostControlSettings, capability: HostCapability): boolean {
  return settings.enabled && settings[capability];
}

/**
 * The one place that decides whether a capability may touch a given container.
 * `restart` keeps its own single-action permission and is not scoped: it is one
 * named container the operator already asked for. Everything that reaches
 * further - state changes, commands, files - must also be on the list.
 */
export function allowsHostTarget(settings: HostControlSettings, name: string): boolean {
  return settings.enabled && matchesHostTarget(settings.targets, name);
}

/** True when an SSH endpoint is described, whether or not a key is stored yet. */
export function sshConfigured(settings: HostControlSettings): boolean {
  return settings.sshHost.length > 0 && settings.sshHostKey.length > 0;
}

/**
 * The SSH endpoint for a run: the settings plus the decrypted key. Undefined
 * unless all four pieces exist, because a partial endpoint can only fail on the
 * host, where the error is far less useful.
 */
export function resolveSshTarget(
  settings: HostControlSettings,
  env: NodeJS.ProcessEnv = process.env,
): SshHostTarget | undefined {
  if (!sshConfigured(settings)) return undefined;
  const privateKey = readSshPrivateKey(env);
  if (!privateKey) return undefined;
  return {
    host: settings.sshHost,
    port: settings.sshPort,
    user: settings.sshUser,
    hostKey: settings.sshHostKey,
    privateKey,
  };
}

/**
 * What a run may do with the host, or undefined when the run gets no host tool.
 *
 * Resolved on the server, per run, exactly like the browser backend and the
 * computer-use switch: the client cannot add a capability by sending an option.
 * The worker receives this snapshot and enforces it on every call; a settings
 * change takes effect on the next turn, not inside a run already in flight.
 *
 * The SSH capabilities stay in the list even when the endpoint is incomplete:
 * the tool then says what is missing, which is more useful than a switch that
 * silently disappeared.
 */
export function readHostControlRunPolicy(env: NodeJS.ProcessEnv = process.env): HostControlRunPolicy | undefined {
  if (!hostControlAvailable(env)) return undefined;
  const settings = readHostControlSettings();
  if (!settings.enabled) return undefined;
  const capabilities = HOST_CAPABILITIES.filter((name) => settings[name]);
  if (capabilities.length === 0) return undefined;
  const ssh = resolveSshTarget(settings, env);
  return {
    socketPath: dockerSocketPath(env),
    capabilities,
    targets: [...settings.targets],
    ...(ssh ? { ssh } : {}),
    // Prior authorization is a grant, so it never rides along without a write
    // permission: a read-only run cannot be talked into a mutating verb.
    ...(settings.sshWritePreauthorized && capabilities.includes('hostWrite')
      ? { sshWritePreauthorized: true }
      : {}),
  };
}

export {
  HOST_CAPABILITIES,
  isHostCapability,
  isTargetPattern,
  matchesHostTarget,
  parseTargets,
} from '../../gjc-engine.js';
export type { HostCapability, HostControlRunPolicy } from '../../gjc-engine.js';
