import { normalizeCatalogEntry, type CatalogEntry } from './catalog.js';

export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const DEFAULT_TTL_MS = 5 * 60_000;

export type RegistryQuery = { search?: string; limit?: number; cursor?: string; version?: string };
export type RegistryResult = { entries: CatalogEntry[]; nextCursor: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type RegistryRecord = Record<string, unknown>;

const INSTALLABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Registry names are reverse-DNS identifiers and often contain `/`, which the
 * mcp.json name validator rejects. The title stays as published; only the
 * installable name is made valid.
 */
function installableName(value: string, fallback: string): string {
  const candidates = [value, fallback];
  for (const candidate of candidates) {
    const cleaned = candidate.trim()
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^[^A-Za-z0-9]+/u, '')
      .slice(0, 64);
    if (INSTALLABLE_NAME.test(cleaned)) return cleaned;
  }
  return 'mcp-server';
}

/**
 * Registry records wrap the server document in `server`. Package metadata
 * carries required/secret environment variables; remotes are streamable HTTP.
 */
export function normalizeRegistryRecord(record: unknown): CatalogEntry | null {
  if (!isRecord(record)) return null;
  const server = isRecord(record.server) ? record.server : record;
  const rawName = typeof server.name === 'string' ? server.name.trim() : '';
  if (!rawName) return null;

  const env: NonNullable<CatalogEntry['env']> = [];
  const packages = Array.isArray(server.packages) ? server.packages.filter(isRecord) : [];
  const first = packages[0];
  const remotes = Array.isArray(server.remotes) ? server.remotes.filter(isRecord) : [];
  const remote = remotes[0];
  const identifier = first && typeof first.identifier === 'string' ? first.identifier : '';
  const name = installableName(rawName, identifier);
  let entry: CatalogEntry | null = null;

  if (first) {
    const registryType = String(first.registryType ?? '').toLowerCase();
    if (identifier) {
      for (const variable of Array.isArray(first.environmentVariables) ? first.environmentVariables : []) {
        if (!isRecord(variable) || typeof variable.name !== 'string') continue;
        env.push({
          name: variable.name,
          required: variable.isRequired === true,
          secret: variable.isSecret === true,
          ...(typeof variable.format === 'string' ? { format: variable.format } : {}),
        });
      }
      const command = registryType === 'npm' ? 'npx' : registryType === 'pypi' ? 'uvx' : 'docker';
      const args = command === 'npx' ? ['-y', identifier] : command === 'docker' ? ['run', '-i', '--rm', identifier] : [identifier];
      const repository = isRecord(server.repository) && typeof server.repository.url === 'string'
        ? { url: server.repository.url, ...(typeof server.repository.source === 'string' ? { source: server.repository.source } : {}) }
        : undefined;
      entry = normalizeCatalogEntry({
        name,
        title: typeof server.title === 'string' ? server.title : undefined,
        description: typeof server.description === 'string' ? server.description : '',
        transport: 'stdio',
        command,
        args,
        package: {
          manager: registryType === 'npm' ? 'npm' : registryType === 'pypi' ? 'pypi' : 'other',
          name: identifier,
          ...(typeof first.version === 'string' ? { version: first.version } : {}),
        },
        env,
        ...(repository ? { repository } : {}),
      }, 'registry');
    }
  }

  if (!entry && remote && typeof remote.url === 'string') {
    entry = normalizeCatalogEntry({
      name,
      title: typeof server.title === 'string' ? server.title : undefined,
      description: typeof server.description === 'string' ? server.description : '',
      transport: /sse/iu.test(String(remote.type ?? '')) ? 'sse' : 'http',
      url: remote.url,
      env,
    }, 'registry');
  }
  return entry;
}

export type RegistryClient = {
  search(query?: RegistryQuery): Promise<RegistryResult>;
  /**
   * The newest published version of a package, asked of the package registry
   * over HTTP rather than through `npm view`: the app already reaches these
   * hosts for catalog search, while a spawned CLI depends on the server
   * process having npm on PATH and its registry config intact.
   */
  latestVersion(manager: 'npm' | 'pypi', name: string): Promise<string | null>;
};

const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const PYPI_REGISTRY_URL = 'https://pypi.org/pypi';
const VERSION_TTL_MS = 10 * 60_000;

export function createRegistryClient(options: {
  baseUrl?: string;
  npmRegistryUrl?: string;
  pypiRegistryUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
} = {}): RegistryClient {
  const baseUrl = options.baseUrl ?? process.env.MCP_REGISTRY_URL ?? OFFICIAL_REGISTRY_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { expires: number; value: RegistryResult }>();
  const versions = new Map<string, { expires: number; value: string | null }>();
  const npmBase = (options.npmRegistryUrl ?? process.env.NPM_REGISTRY_URL ?? NPM_REGISTRY_URL).replace(/\/+$/u, '');
  const pypiBase = (options.pypiRegistryUrl ?? process.env.PYPI_REGISTRY_URL ?? PYPI_REGISTRY_URL).replace(/\/+$/u, '');

  async function fetchLatest(manager: 'npm' | 'pypi', name: string): Promise<string | null> {
    const key = `${manager}:${name}`;
    const hit = versions.get(key);
    if (hit && hit.expires > now()) return hit.value;
    let value: string | null = null;
    try {
      // Scoped npm names keep their slash; the registry path expects it.
      const url = manager === 'npm'
        ? `${npmBase}/${name.replace(/^\//u, '')}/latest`
        : `${pypiBase}/${encodeURIComponent(name)}/json`;
      const response = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        const body = await response.json() as unknown;
        const candidate = manager === 'npm'
          ? isRecord(body) ? body.version : undefined
          : isRecord(body) && isRecord(body.info) ? body.info.version : undefined;
        if (typeof candidate === 'string' && candidate.trim()) value = candidate.trim();
      }
    } catch {
      value = null;
    }
    versions.set(key, { expires: now() + VERSION_TTL_MS, value });
    return value;
  }

  return {
    latestVersion: fetchLatest,

    async search(query: RegistryQuery = {}): Promise<RegistryResult> {
      const search = query.search?.trim();
      // The registry rejects short searches; answer before spending a request.
      if (search !== undefined && search.length > 0 && search.length < 3) {
        throw new Error('Search requires at least 3 characters.');
      }
      const limit = Math.min(100, Math.max(1, Number.isFinite(query.limit) ? Number(query.limit) : 20));
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      params.set('limit', String(limit));
      params.set('version', query.version ?? 'latest');
      if (query.cursor) params.set('cursor', query.cursor);
      const key = params.toString();
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return hit.value;

      const response = await doFetch(`${baseUrl}?${key}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`The MCP registry returned HTTP ${response.status}.`);
      const body = await response.json() as unknown;
      const records = isRecord(body) && Array.isArray(body.servers) ? body.servers
        : isRecord(body) && isRecord(body.result) && Array.isArray(body.result.servers) ? body.result.servers
          : [];
      const seen = new Set<string>();
      const entries: CatalogEntry[] = [];
      for (const record of records) {
        const entry = normalizeRegistryRecord(record);
        // One record per version: the same server/version pair appears once.
        const versionKey = `${entry?.name}@${entry?.package?.version ?? ''}`;
        if (!entry || seen.has(versionKey)) continue;
        seen.add(versionKey);
        entries.push(entry);
      }
      const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : undefined;
      const legacy = isRecord(body) && isRecord(body.result) ? body.result : undefined;
      const nextCursor = typeof metadata?.nextCursor === 'string' ? metadata.nextCursor
        : typeof legacy?.nextCursor === 'string' ? legacy.nextCursor : null;
      const value = { entries, nextCursor };
      cache.set(key, { expires: now() + ttl, value });
      return value;
    },
  };
}
