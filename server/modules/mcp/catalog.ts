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
};

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/websterwh/gajae-code-app/main/deploy/mcp/catalog.json';
const OVERLAY_TTL_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
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
    source,
  };
}

export function bundledCatalog(): CatalogEntry[] {
  return (bundledRaw as unknown[])
    .map((entry) => normalizeCatalogEntry(entry, 'bundled'))
    .filter((entry): entry is CatalogEntry => entry !== null);
}

/**
 * Baseline, then overlay (overrides by name), then registry entries that do
 * not duplicate a curated name. A registry result never replaces something
 * the project curates deliberately.
 */
export function mergeCatalog(baseline: CatalogEntry[], overlay: CatalogEntry[], registry: CatalogEntry[] = []): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>();
  for (const entry of baseline) byName.set(entry.name, entry);
  for (const entry of overlay) byName.set(entry.name, entry);
  for (const entry of registry) if (!byName.has(entry.name)) byName.set(entry.name, entry);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function searchCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const term = query.trim().toLowerCase();
  if (!term) return entries;
  return entries.filter((entry) => [entry.name, entry.title, entry.description]
    .some((field) => String(field ?? '').toLowerCase().includes(term)));
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
