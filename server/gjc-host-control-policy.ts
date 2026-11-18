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
};

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
