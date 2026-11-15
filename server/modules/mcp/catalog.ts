import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import bundledRaw from './catalog.data.json' with { type: 'json' };

export type CatalogSource = 'bundled' | 'overlay' | 'registry';
export type CatalogTransport = 'stdio' | 'http' | 'sse';

export type CatalogEnvVar = {
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
  format?: string;
};

export type CatalogMount = { path: string; purpose?: string };

export type CatalogPackage = { manager: 'npm' | 'pypi' | 'git' | 'other'; name: string; version?: string };

export type CatalogEntry = {
  name: string;
  title?: string;
  description: string;
  transport: CatalogTransport;
  command?: string;
  args?: string[];
  url?: string;
  package?: CatalogPackage;
  env?: CatalogEnvVar[];
  requires?: { mounts?: CatalogMount[] };
  source: CatalogSource;
  stars?: number;
  popularity?: number;
  homepage?: string;
  repository?: { url: string; source?: string };
};

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/websterwh/gajae-code-app/main/deploy/mcp/catalog.json';
const OVERLAY_TTL_MS = 24 * 60 * 60_000;
const STAR_TTL_MS = 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function envVars(value: unknown): CatalogEnvVar[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const vars: CatalogEnvVar[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue;
    vars.push({
      name: entry.name,
      required: entry.required === true,
      secret: entry.secret === true,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.format === 'string' ? { format: entry.format } : {}),
    });
  }
  return vars.length ? vars : undefined;
}

function mounts(value: unknown): CatalogMount[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.mounts)) return undefined;
  const list = value.mounts
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.path === 'string' && entry.path.length > 0)
    .map((entry) => ({ path: entry.path as string, ...(typeof entry.purpose === 'string' ? { purpose: entry.purpose } : {}) }));
  return list.length ? list : undefined;
}

function repository(value: unknown): CatalogEntry['repository'] | undefined {
  if (!isRecord(value) || typeof value.url !== 'string' || !value.url) return undefined;
  return { url: value.url, ...(typeof value.source === 'string' ? { source: value.source } : {}) };
}

/** One overlay entry; anything that cannot be installed safely is skipped. */
export function normalizeCatalogEntry(value: unknown, source: CatalogSource): CatalogEntry | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const transport = String(value.transport ?? '').toLowerCase();
  if (!name || (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')) return null;
  const command = typeof value.command === 'string' ? value.command : undefined;
  const url = typeof value.url === 'string' ? value.url : undefined;
  if (transport === 'stdio' && !command) return null;
  if (transport !== 'stdio' && !url) return null;
  const pkg = isRecord(value.package) && typeof value.package.name === 'string' && value.package.name
    ? {
        manager: ['npm', 'pypi', 'git', 'other'].includes(String(value.package.manager)) ? String(value.package.manager) as CatalogPackage['manager'] : 'other',
        name: value.package.name,
        ...(typeof value.package.version === 'string' ? { version: value.package.version } : {}),
      }
    : undefined;
  const stars = nonNegativeNumber(value.stars);
  const popularity = nonNegativeNumber(value.popularity);
  const repo = repository(value.repository);
  return {
    name,
    description: typeof value.description === 'string' ? value.description : '',
    transport,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(command ? { command } : {}),
    ...(stringArray(value.args) ? { args: stringArray(value.args) as string[] } : {}),
    ...(url ? { url } : {}),
    ...(pkg ? { package: pkg } : {}),
    ...(envVars(value.env) ? { env: envVars(value.env) as CatalogEnvVar[] } : {}),
    ...(mounts(value.requires) ? { requires: { mounts: mounts(value.requires) as CatalogMount[] } } : {}),
    ...(typeof value.homepage === 'string' ? { homepage: value.homepage } : {}),
    ...(repo ? { repository: repo } : {}),
    ...(stars !== undefined ? { stars } : {}),
    ...(popularity !== undefined ? { popularity } : {}),
    source,
  };
}

export function bundledCatalog(): CatalogEntry[] {
  return (bundledRaw as unknown[])
    .map((entry) => normalizeCatalogEntry(entry, 'bundled'))
    .filter((entry): entry is CatalogEntry => entry !== null);
}

const compact = (value: string | undefined): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
const tokens = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);

/**
 * A registry record that repeats a curated title or package is the same server
 * published twice. Keep the curated card and drop the duplicate.
 */
export function mergeCatalog(baseline: CatalogEntry[], overlay: CatalogEntry[], registry: CatalogEntry[] = []): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>();
  for (const entry of baseline) byName.set(entry.name, entry);
  for (const entry of overlay) byName.set(entry.name, entry);

  const curatedTitles = new Set<string>();
  const curatedPackages = new Set<string>();
  for (const entry of byName.values()) {
    for (const title of [entry.title, entry.name]) {
      const key = compact(title);
      if (key) curatedTitles.add(key);
    }
    if (entry.package?.name) curatedPackages.add(entry.package.name.toLowerCase());
  }

  for (const entry of registry) {
    if (byName.has(entry.name)) continue;
    if (entry.package?.name && curatedPackages.has(entry.package.name.toLowerCase())) continue;
    if ([entry.title, entry.name].some((title) => curatedTitles.has(compact(title)))) continue;
    byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type MatchTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

function matchTier(entry: CatalogEntry, query: string): MatchTier | null {
  const term = query.trim().toLowerCase();
  if (!term) return null;
  const compactTerm = compact(term);
  const compactName = compact(entry.name);
  const compactTitle = compact(entry.title);
  if (compactName === compactTerm) return 0;
  if (compactTitle && compactTitle === compactTerm) return 1;
  if (compactTerm && compactName.startsWith(compactTerm)) return 2;
  if (compactTerm && compactTitle.startsWith(compactTerm)) return 3;

  const words = tokens(term);
  const description = entry.description.toLowerCase();
  const descriptionWords = new Set(tokens(description));
  if (words.length > 0 && words.every((word) => descriptionWords.has(word))) return 4;

  const haystack = [entry.name, entry.title ?? '', entry.description].join(' ').toLowerCase();
  if (haystack.includes(term)) return 5;
  if (compactTerm && compact(haystack).includes(compactTerm)) return 6;
  const haystackTokens = new Set(tokens(haystack));
  if (words.length > 0 && words.every((word) => haystackTokens.has(word))) return 6;
  return null;
}

/** Namespaced records (`vendor/name`, `com.vendor.name`) lose ties. */
function hygienePenalty(entry: CatalogEntry): number {
  const first = entry.name.split('/')[0] ?? '';
  return entry.name.includes('/') || first.includes('.') ? 1 : 0;
}

const SOURCE_RANK: Record<CatalogSource, number> = { bundled: 0, overlay: 1, registry: 2 };

export type RankedEntry = { entry: CatalogEntry; tier: MatchTier };

/**
 * Curated entries outrank registry records, then match quality, popularity and
 * name hygiene decide. The name tie-break keeps the order deterministic.
 */
export function rankCatalog(entries: RankedEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const source = SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source];
    if (source !== 0) return source;
    if (a.tier !== b.tier) return a.tier - b.tier;
    const stars = (b.entry.stars ?? 0) - (a.entry.stars ?? 0);
    if (stars !== 0) return stars;
    const popularity = (b.entry.popularity ?? 0) - (a.entry.popularity ?? 0);
    if (popularity !== 0) return popularity;
    const hygiene = hygienePenalty(a.entry) - hygienePenalty(b.entry);
    if (hygiene !== 0) return hygiene;
    return a.entry.name.localeCompare(b.entry.name);
  }).map((ranked) => ranked.entry);
}

export function searchCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const term = query.trim();
  if (!term) return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const ranked: RankedEntry[] = [];
  for (const entry of entries) {
    const tier = matchTier(entry, term);
    if (tier !== null) ranked.push({ entry, tier });
  }
  return rankCatalog(ranked);
}

const starCache = new Map<string, { value: number | undefined; expires: number }>();

function githubRepo(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/u.exec(url);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/u, '')}`;
}

/**
 * Best-effort stars: a bounded number of lookups per response, cached for an
 * hour. A missing token, a rate limit or an unknown repo means "no number",
 * never an error and never a blocked render.
 */
export async function attachGitHubStars(entries: CatalogEntry[], options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  limit?: number;
  token?: string;
} = {}): Promise<CatalogEntry[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const limit = options.limit ?? 8;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const candidates = entries
    .filter((entry) => entry.stars === undefined && githubRepo(entry.repository?.url))
    .slice(0, limit);

  const resolved = new Map<string, number>();
  await Promise.all(candidates.map(async (entry) => {
    const repo = githubRepo(entry.repository?.url) as string;
    const hit = starCache.get(repo);
    if (hit && hit.expires > now()) {
      if (hit.value !== undefined) resolved.set(repo, hit.value);
      return;
    }
    try {
      const response = await doFetch(`https://api.github.com/repos/${repo}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'gajae-code-app',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
      const body = response.ok ? await response.json() as { stargazers_count?: unknown } : null;
      const value = typeof body?.stargazers_count === 'number' ? body.stargazers_count : undefined;
      starCache.set(repo, { value, expires: now() + STAR_TTL_MS });
      if (value !== undefined) resolved.set(repo, value);
    } catch {
      starCache.set(repo, { value: undefined, expires: now() + STAR_TTL_MS });
    }
  }));

  if (resolved.size === 0) return entries;
  return entries.map((entry) => {
    const repo = githubRepo(entry.repository?.url);
    const stars = repo ? resolved.get(repo) : undefined;
    return stars === undefined || entry.stars !== undefined ? entry : { ...entry, stars };
  });
}

type OverlayCache = { etag?: string; fetchedAt: number; entries: CatalogEntry[] };

export type OverlayResult = { entries: CatalogEntry[]; warning?: string };

/**
 * The overlay is how the list grows without shipping an image. A malformed
 * payload is ignored with a warning, never a crash, and the last good cached
 * copy keeps working.
 */
export async function loadOverlay(options: {
  url?: string;
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
} = {}): Promise<OverlayResult> {
  const url = options.url ?? process.env.MCP_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const cacheFile = options.cacheFile;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? OVERLAY_TTL_MS;

  let cached: OverlayCache | null = null;
  if (cacheFile) {
    try {
      const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as OverlayCache;
      if (Array.isArray(parsed.entries) && Number.isFinite(parsed.fetchedAt)) cached = parsed;
    } catch {
      cached = null;
    }
  }
  if (cached && now() - cached.fetchedAt < ttl) return { entries: cached.entries };

  try {
    const response = await doFetch(url, {
      headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 304 && cached) return { entries: cached.entries };
    if (!response.ok) {
      return {
        entries: cached?.entries ?? [],
        warning: `Catalog overlay returned HTTP ${response.status}; using ${cached ? 'the cached copy' : 'the bundled catalog only'}.`,
      };
    }
    const body = await response.json() as unknown;
    const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.servers) ? body.servers : null;
    if (!list) {
      return { entries: cached?.entries ?? [], warning: 'Catalog overlay was not a server list; ignored.' };
    }
    const entries = list
      .map((entry) => normalizeCatalogEntry(entry, 'overlay'))
      .filter((entry): entry is CatalogEntry => entry !== null);
    if (list.length > 0 && entries.length === 0) {
      return { entries: cached?.entries ?? [], warning: 'Catalog overlay had no valid entries; ignored.' };
    }
    const etag = response.headers.get('etag') ?? undefined;
    if (cacheFile) {
      try {
        await mkdir(path.dirname(cacheFile), { recursive: true });
        const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ etag, fetchedAt: now(), entries }, null, 2)}\n`, 'utf8');
        await rename(temporary, cacheFile);
      } catch {
        // The catalog still works without a cache.
      }
    }
    return { entries };
  } catch (error) {
    return {
      entries: cached?.entries ?? [],
      warning: `Catalog overlay could not be read (${error instanceof Error ? error.message : 'network error'}); using ${cached ? 'the cached copy' : 'the bundled catalog only'}.`,
    };
  }
}
