import { normalizeCatalogEntry, type CatalogEntry } from './catalog.js';

export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const DEFAULT_TTL_MS = 5 * 60_000;

export type RegistryQuery = { search?: string; limit?: number; cursor?: string; version?: string };
export type RegistryResult = { entries: CatalogEntry[]; nextCursor: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type RegistryRecord = Record<string, unknown>;

/**
 * Registry records wrap the server document in `server`. Package metadata
 * carries required/secret environment variables; remotes are streamable HTTP.
 */
export function normalizeRegistryRecord(record: unknown): CatalogEntry | null {
  if (!isRecord(record)) return null;
  const server = isRecord(record.server) ? record.server : record;
  const name = typeof server.name === 'string' ? server.name.trim() : '';
  if (!name) return null;

  const env: NonNullable<CatalogEntry['env']> = [];
  const packages = Array.isArray(server.packages) ? server.packages.filter(isRecord) : [];
  const first = packages[0];
  const remotes = Array.isArray(server.remotes) ? server.remotes.filter(isRecord) : [];
  const remote = remotes[0];
  let entry: CatalogEntry | null = null;

  if (first) {
    const identifier = typeof first.identifier === 'string' ? first.identifier : '';
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

export type RegistryClient = { search(query?: RegistryQuery): Promise<RegistryResult> };

export function createRegistryClient(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
} = {}): RegistryClient {
  const baseUrl = options.baseUrl ?? process.env.MCP_REGISTRY_URL ?? OFFICIAL_REGISTRY_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { expires: number; value: RegistryResult }>();

  return {
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
