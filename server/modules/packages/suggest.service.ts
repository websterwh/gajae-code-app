import type { CommandRunner, InstallManager } from '../mcp/index.js';

/**
 * "Autodetect" is three existing endpoints, not a scraper of our own:
 * apt ships its index locally, npm runs a registry search API, and PyPI has a
 * per-project JSON API. aqua has no queryable public index (its registry is a
 * git repository of YAML files), so it is not a suggestion source; the package
 * field still accepts `owner/repo` typed by hand.
 */
export type PackageSuggestion = {
  manager: Extract<InstallManager, 'apt' | 'npm' | 'pip'>;
  name: string;
  spec: string;
  description: string;
};

type FetchResponse = { ok: boolean; json: () => Promise<unknown> };
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;

type SuggestOptions = {
  runner?: CommandRunner;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

const APT_LIMIT = 6;
const NPM_LIMIT = 6;
const TOTAL_LIMIT = 12;
/** A refined query (zox -> zoxid -> zoxide) hits the same sources twice. */
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 50;

/** A name is also the argument apt and pip will receive, so keep it to a name. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/iu;

const prefixFirst = (query: string) => (first: PackageSuggestion, second: PackageSuggestion): number => {
  const needle = query.toLowerCase();
  const rank = (suggestion: PackageSuggestion): number => (
    suggestion.name.toLowerCase() === needle ? 0
      : suggestion.name.toLowerCase().startsWith(needle) ? 1 : 2
  );
  return rank(first) - rank(second) || first.name.localeCompare(second.name);
};

export class PackageSuggestService {
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; suggestions: PackageSuggestion[] }>();

  constructor(private readonly options: SuggestOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  private fetcher(): FetchLike {
    return this.options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async apt(query: string): Promise<PackageSuggestion[]> {
    if (!this.options.runner) return [];
    // Local and offline: apt-cache reads the index the image already built.
    const result = await this.options.runner('apt-cache', ['search', '--names-only', query]);
    if (result.code !== 0) return [];
    const suggestions: PackageSuggestion[] = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      const separator = line.indexOf(' - ');
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (!PACKAGE_NAME.test(name)) continue;
      suggestions.push({ manager: 'apt', name, spec: name, description: line.slice(separator + 3).trim() });
      if (suggestions.length === APT_LIMIT) break;
    }
    return suggestions;
  }

  private async npm(query: string): Promise<PackageSuggestion[]> {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${NPM_LIMIT}`;
    const response = await this.fetcher()(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) return [];
    const body = await response.json() as { objects?: Array<{ package?: { name?: string; description?: string } }> };
    return (body.objects ?? []).flatMap((object) => {
      const name = object.package?.name;
      if (!name || !PACKAGE_NAME.test(name)) return [];
      return [{ manager: 'npm' as const, name, spec: name, description: object.package?.description ?? '' }];
    });
  }

  /** PyPI has no search endpoint; the project JSON API answers for an exact name. */
  private async pypi(query: string): Promise<PackageSuggestion[]> {
    if (!PACKAGE_NAME.test(query)) return [];
    const url = `https://pypi.org/pypi/${encodeURIComponent(query)}/json`;
    const response = await this.fetcher()(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) return [];
    const body = await response.json() as { info?: { name?: string; summary?: string } };
    const name = body.info?.name;
    if (!name || !PACKAGE_NAME.test(name)) return [];
    return [{ manager: 'pip', name, spec: name, description: body.info?.summary ?? '' }];
  }

  async suggest(rawQuery: string): Promise<PackageSuggestion[]> {
    const query = rawQuery.trim();
    // One character matches half the index and costs three round trips.
    if (query.length < 2) return [];
    const cacheKey = query.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suggestions;
    const [apt, npm, pypi] = await Promise.all([
      this.apt(query).catch(() => []),
      this.npm(query).catch(() => []),
      this.pypi(query).catch(() => []),
    ]);
    const unique = new Map<string, PackageSuggestion>();
    for (const suggestion of [...apt, ...npm, ...pypi]) {
      const key = `${suggestion.manager}:${suggestion.name}`;
      if (!unique.has(key)) unique.set(key, suggestion);
    }
    const suggestions = [...unique.values()].sort(prefixFirst(query)).slice(0, TOTAL_LIMIT);
    this.cache.set(cacheKey, { at: Date.now(), suggestions });
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return suggestions;
  }
}

export const packageSuggestService = new PackageSuggestService();
