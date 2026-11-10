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

export function hostControlAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env.GAJAE_HOST_CONTROL ?? '').trim().toLowerCase());
}

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.GAJAE_DOCKER_SOCKET ?? '').trim();
  return configured || '/var/run/docker.sock';
}

export type HostCapability = 'facts' | 'containers' | 'restart';

export type HostControlSettings = { enabled: boolean } & Record<HostCapability, boolean>;

export const DEFAULT_HOST_CONTROL_SETTINGS: HostControlSettings = {
  enabled: false,
  facts: false,
  containers: false,
  restart: false,
};

const flag = (value: unknown): boolean => value === true;

export function readHostControlSettings(): HostControlSettings {
  const raw = appConfigDb.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_HOST_CONTROL_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<HostControlSettings>;
    return {
      enabled: flag(parsed.enabled),
      facts: flag(parsed.facts),
      containers: flag(parsed.containers),
      restart: flag(parsed.restart),
    };
  } catch {
    return { ...DEFAULT_HOST_CONTROL_SETTINGS };
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
  };
  // A capability never outlives the master switch. Turning host control off
  // drops every permission with it, so turning it back on can never silently
  // restore a restart permission the operator had already switched off.
  if (!next.enabled) {
    next.facts = false;
    next.containers = false;
    next.restart = false;
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
