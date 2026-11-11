import { appConfigDb } from '@/modules/database/index.js';

/**
 * Host control is opt-in twice over.
 *
 * `GAJAE_HOST_CONTROL` admits the feature at all: without it no route answers
 * anything but "not available", so an image deployed without it cannot be
 * talked into host access by a setting, a request or a container name. The
 * settings below then decide, capability by capability, what the app may do
 * with the socket it was given - and they all start off.
 *
 * This deliberately does not reuse the desktop companion's device pairing: a
 * host is not a device to be trusted per browser session, it is the machine
 * this container runs on, so the operator states the permission once, in the
 * environment and in Settings, and the socket mount is the whole transport.
 */
const CONFIG_KEY = 'host.control.v1';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** `*` and `?` are globs; everything else is a literal container-name character. */
const TARGET_PATTERN = /^[A-Za-z0-9*?_.-]{1,128}$/u;

const MAX_TARGETS = 50;

export function hostControlAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env.GAJAE_HOST_CONTROL ?? '').trim().toLowerCase());
}

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.GAJAE_DOCKER_SOCKET ?? '').trim();
  return configured || '/var/run/docker.sock';
}

export type HostCapability =
  | 'facts'
  | 'containers'
  | 'restart'
  | 'discovery'
  | 'docker'
  | 'shell'
  | 'files';

export const HOST_CAPABILITIES: readonly HostCapability[] = [
  'facts',
  'containers',
  'restart',
  'discovery',
  'docker',
  'shell',
  'files',
];

export type HostControlSettings = {
  enabled: boolean;
  /** Container-name globs the reaching capabilities may touch. Empty means none. */
  targets: string[];
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
  targets: [],
};

const flag = (value: unknown): boolean => value === true;

export function isTargetPattern(value: unknown): value is string {
  return typeof value === 'string' && TARGET_PATTERN.test(value);
}

export function parseTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const patterns = value
    .filter(isTargetPattern)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
  return [...new Set(patterns)].slice(0, MAX_TARGETS);
}

/**
 * A container-name glob, not a path or a regex: `mos-*`, `immich_?`, `gajae-app`.
 * Matching is case-insensitive because container names are typed by people.
 */
export function matchesHostTarget(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => {
    const source = pattern
      .split('')
      .map((character) => {
        if (character === '*') return '.*';
        if (character === '?') return '.';
        return character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      })
      .join('');
    return new RegExp(`^${source}$`, 'iu').test(name);
  });
}

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
      targets: parseTargets(parsed.targets),
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
    targets: patch.targets === undefined ? [...current.targets] : parseTargets(patch.targets),
  };
  // A capability never outlives the master switch. Turning host control off
  // drops every permission with it, so turning it back on can never silently
  // restore a restart permission the operator had already switched off - and
  // the target scope goes with them, so the next enable starts from nothing.
  if (!next.enabled) {
    next.facts = false;
    next.containers = false;
    next.restart = false;
    next.discovery = false;
    next.docker = false;
    next.shell = false;
    next.files = false;
    next.targets = [];
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
