/**
 * The pure part of host control.
 *
 * The settings store and the agent's `host` tool both need the capability
 * vocabulary, the container-name glob and the shape of what one run may do.
 * Keeping them here means the tool can be bundled into the GJC worker without
 * pulling the app database the settings store reads.
 */

export type HostCapability =
  | 'facts'
  | 'containers'
  | 'restart'
  | 'discovery'
  | 'docker'
  | 'shell'
  | 'files'
  | 'hostRead'
  | 'hostWrite';

export const HOST_CAPABILITIES: readonly HostCapability[] = [
  'facts',
  'containers',
  'restart',
  'discovery',
  'docker',
  'shell',
  'files',
  'hostRead',
  'hostWrite',
];

export function isHostCapability(value: unknown): value is HostCapability {
  return typeof value === 'string' && (HOST_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * What one run may do with the host, resolved by the server before the run
 * starts - the same trust boundary as the permission policy. The worker never
 * reads the settings store itself.
 */
export type HostControlRunPolicy = {
  socketPath: string;
  capabilities: HostCapability[];
  targets: string[];
  /**
   * The machine reachable over SSH, when one is configured. The private key is
   * decrypted on the server and only ever exists in this per-run snapshot - the
   * worker never reads the settings store.
   */
  ssh?: SshHostTarget;
  /**
   * The operator already permitted host writes, so a write verb runs without
   * asking again. Off by default: a write asks on every call, in every
   * permission mode, including a trusted (`bypass`) run.
   */
  sshWritePreauthorized?: boolean;
};

/** One SSH endpoint: what to connect to, and how it is authenticated. */
export type SshHostTarget = {
  host: string;
  port: number;
  user: string;
  /** The pinned server host key, `ssh-ed25519 AAAA…`, never a fingerprint. */
  hostKey: string;
  privateKey: string;
};

/**
 * A hostname or a literal address. The first character must be alphanumeric so
 * a value can never be read as an `ssh` option (`-oProxyCommand=…`), and it is
 * always passed as its own argv entry, never through a shell here.
 */
export const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/u;

export const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/u;

/** The host-key algorithms worth pinning; anything else is not a host key. */
export const SSH_HOST_KEY_ALGORITHMS: readonly string[] = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
];

/** A remote target is a plain container or service name, exactly as in `verbs.mjs`. */
export const SSH_REMOTE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u;

export const MAX_SSH_PRIVATE_KEY_BYTES = 16 * 1024;

export function isSshHost(value: unknown): value is string {
  return typeof value === 'string' && SSH_HOST_PATTERN.test(value);
}

export function isSshUser(value: unknown): value is string {
  return typeof value === 'string' && SSH_USER_PATTERN.test(value);
}

export function parseSshPort(value: unknown): number | undefined {
  const port = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

/**
 * Normalizes a pasted host key. `ssh-keyscan` prints `host keytype base64`, and
 * people paste that whole line, so the leading host token is accepted and
 * dropped - what is pinned is only the algorithm and the key material.
 */
export function parseSshHostKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.trim().split(/\s+/u);
  const index = parts.findIndex((part) => SSH_HOST_KEY_ALGORITHMS.includes(part));
  if (index < 0) return undefined;
  const algorithm = parts[index]!;
  const material = parts[index + 1];
  if (!material || !/^[A-Za-z0-9+/]+={0,2}$/u.test(material)) return undefined;
  return `${algorithm} ${material}`;
}

/** A private key in PEM/OpenSSH form, with the envelope checked both ways. */
export function parseSshPrivateKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  if (key.length === 0 || Buffer.byteLength(key, 'utf8') > MAX_SSH_PRIVATE_KEY_BYTES) return undefined;
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(key)) return undefined;
  if (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(key)) return undefined;
  return key;
}

export function isRemoteTarget(value: unknown): value is string {
  return typeof value === 'string' && SSH_REMOTE_TARGET_PATTERN.test(value);
}

/** `*` and `?` are globs; everything else is a literal container-name character. */
const TARGET_PATTERN = /^[A-Za-z0-9*?_.-]{1,128}$/u;

const MAX_TARGETS = 50;

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
