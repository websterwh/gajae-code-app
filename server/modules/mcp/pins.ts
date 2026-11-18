/**
 * A pin is a package version, not a catalog identity: `pkg@1.2.3` for npm,
 * `pkg==1.2.3` for PyPI. `latest` is never a stored pin - it is unresolved at
 * rest and only a request to install the newest available version.
 */
export type ParsedManager = 'npm' | 'pypi' | 'git' | 'other';

export type ParsedPackageSpec = {
  raw: string;
  name: string;
  version: string | null;
  manager: ParsedManager;
};

function stripGitSource(raw: string): string {
  const withoutPrefix = raw.replace(/^git\+/u, '');
  const withoutFragment = withoutPrefix.split('#')[0] ?? withoutPrefix;
  const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
  const lastSegment = withoutQuery.replace(/\/+$/u, '').split('/').pop() ?? withoutQuery;
  return lastSegment.replace(/\.git$/u, '');
}

export function parsePackageSpec(rawSpec: string): ParsedPackageSpec {
  const raw = String(rawSpec ?? '').trim();
  if (!raw) return { raw, name: '', version: null, manager: 'other' };

  if (raw.startsWith('git+') || /^https?:\/\//u.test(raw)) {
    const name = stripGitSource(raw) || raw;
    return { raw, name, version: null, manager: 'git' };
  }

  if (raw.includes('==')) {
    const [name, version] = raw.split('==');
    return { raw, name: (name ?? '').trim(), version: (version ?? '').trim() || null, manager: 'pypi' };
  }

  // Scoped npm names start with `@`, so the version separator is the last `@`
  // after the first character.
  const separator = raw.lastIndexOf('@');
  if (separator > 0) {
    return {
      raw,
      name: raw.slice(0, separator),
      version: raw.slice(separator + 1) || null,
      manager: 'npm',
    };
  }

  return { raw, name: raw, version: null, manager: 'other' };
}

/** `latest`/`*` mean "unpinned"; an empty value means unpin entirely. */
export function normalizePin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const version = String(value).trim();
  if (!version || version === 'latest' || version === '*') return null;
  return version;
}

/** The install spec for a package with an optional pin, in the manager's syntax. */
export function pinnedSpec(
  parsed: ParsedPackageSpec,
  pin: string | null | undefined,
  manager?: 'uv' | 'pip' | 'npm' | 'aqua' | 'apt',
): string {
  const version = normalizePin(pin);
  if (!version) return parsed.raw;
  // A git checkout has no package version to pin.
  if (parsed.manager === 'git') return parsed.raw;
  // apt addresses a version as `name=version`.
  if (manager === 'apt') return `${parsed.name}=${version}`;
  // A GitHub release is pinned by the tag it was fetched at: `skylot/jadx@v1.5.1`.
  if (manager === 'aqua') return `${parsed.name}@${version}`;
  if (manager === 'npm' || (manager === undefined && parsed.manager === 'npm')) return `${parsed.name}@${version}`;
  if (manager === 'uv' || manager === 'pip' || parsed.manager === 'pypi') return `${parsed.name}==${version}`;
  // A git checkout has no package version to pin.
  return parsed.raw;
}

export function isPinnableTransport(transport: string): boolean {
  return transport === 'stdio';
}

export function shouldAutoUpdate(pin: string | null | undefined): boolean {
  return normalizePin(pin) === null;
}

/** True when `candidate` is older than `current`; the caller then pins it. */
export function isDowngrade(current: string | null | undefined, candidate: string | null | undefined): boolean {
  const toParts = (value: string | null | undefined): number[] | null => {
    if (!value) return null;
    const parts = String(value).trim().replace(/^v/u, '').split('.').map((part) => Number.parseInt(part, 10));
    return parts.every(Number.isFinite) ? parts : null;
  };
  const a = toParts(current);
  const b = toParts(candidate);
  if (!a || !b) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (right < left) return true;
    if (right > left) return false;
  }
  return false;
}
