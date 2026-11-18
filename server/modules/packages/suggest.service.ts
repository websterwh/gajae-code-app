import type { CommandRunner, InstallManager } from '../mcp/index.js';

/**
 * "Autodetect" is four existing endpoints, not a scraper of our own:
 * apt ships its index locally, npm runs a registry search API, PyPI has a
 * per-project JSON API, and GitHub's repository search stands in for aqua.
 *
 * aqua has no queryable index of its own - its registry is a git repository of
 * YAML - but every aqua package is a GitHub release, so the repository search
 * answers the question the user is actually asking ("where is the GitHub CLI
 * from?"). A repository without release assets still fails at install time;
 * the alternative was offering nothing at all.
 *
 * The search is the only unauthenticated call here, and GitHub allows it ten
 * times a minute. The token saved in Settings is already in this process's
 * environment (see github-auth.service), so using it costs nothing and raises
 * that to thirty - the search API counts differently for anonymous callers.
 */
export type PackageSuggestion = {
  manager: InstallManager;
  name: string;
  spec: string;
  description: string;
};

export type SuggestManager = InstallManager | 'auto';

type FetchResponse = { ok: boolean; json: () => Promise<unknown> };
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>;

type SuggestOptions = {
  runner?: CommandRunner;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

const APT_LIMIT = 6;
const NPM_LIMIT = 6;
const GITHUB_LIMIT = 6;
const TOTAL_LIMIT = 12;
/**
 * A description search can match thousands of lines, and apt-cache prints them
 * sorted by name. Ranking has to happen over the whole window before the best
 * few are taken, or the winner is whichever package starts with "a".
 */
const APT_SCAN_LIMIT = 20_000;
/** A refined query (zox -> zoxid -> zoxide) hits the same sources twice. */
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 50;

/** A name is also the argument apt and pip will receive, so keep it to a name. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/iu;
/** `owner/repo`, the only spec shape the GitHub-release installer accepts. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/**
 * Name matches outrank description matches, and a description that opens with
 * the query ("GitHub CLI" for `github`) outranks a name that merely embeds it.
 *
 * That middle tier is the whole point: `github` matches 1700+ packages whose
 * names contain it (`golang-github-*-dev`), and ranking names first buried the
 * one answer the user wanted - `gh`, the GitHub CLI, whose own name has
 * nothing to do with GitHub.
 */
const rank = (suggestion: PackageSuggestion, needle: string): number => {
  const name = suggestion.name.toLowerCase();
  const description = suggestion.description.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (description.startsWith(needle)) return 2;
  if (name.includes(needle)) return 3;
  if (description.includes(` ${needle}`)) return 4;
  return 5;
};

const prefixFirst = (query: string) => (first: PackageSuggestion, second: PackageSuggestion): number => (
  rank(first, query.toLowerCase()) - rank(second, query.toLowerCase())
  || first.name.localeCompare(second.name)
);

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
    // Not `--names-only`: `github` is a name nobody ships, but `gh` describes
    // itself as the GitHub CLI, which is what the user was looking for.
    const result = await this.options.runner('apt-cache', ['search', query]);
    if (result.code !== 0) return [];
    const suggestions: PackageSuggestion[] = [];
    for (const line of result.stdout.split(/\r?\n/u).slice(0, APT_SCAN_LIMIT)) {
      const separator = line.indexOf(' - ');
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (!PACKAGE_NAME.test(name)) continue;
      suggestions.push({ manager: 'apt', name, spec: name, description: line.slice(separator + 3).trim() });
    }
    return suggestions.sort(prefixFirst(query)).slice(0, APT_LIMIT);
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

  private async github(query: string): Promise<PackageSuggestion[]> {
    const search = encodeURIComponent(`${query} in:name`);
    const url = `https://api.github.com/search/repositories?q=${search}&sort=stars&order=desc&per_page=${GITHUB_LIMIT}`;
    // Read on each call: a token saved after boot is in the environment without
    // a restart, and nothing here outlives the request it was read for.
    const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
    const response = await this.fetcher()(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'gajae-code-app',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) return [];
    const body = await response.json() as {
      items?: Array<{ full_name?: string; description?: string | null; archived?: boolean }>;
    };
    return (body.items ?? []).flatMap((item) => {
      const repo = item.full_name ?? '';
      if (item.archived || !REPOSITORY.test(repo)) return [];
      return [{ manager: 'aqua' as const, name: repo, spec: repo, description: item.description ?? '' }];
    });
  }

  /**
   * `auto` searches every source. A chosen manager searches only itself, so
   * picking `aqua` cannot answer with npm packages; uv and pip are both PyPI,
   * so the selected one is the manager the suggestion installs through.
   */
  async suggest(rawQuery: string, manager: SuggestManager = 'auto'): Promise<PackageSuggestion[]> {
    const query = rawQuery.trim();
    // One character matches half the index and costs three round trips.
    if (query.length < 2) return [];
    const cacheKey = `${manager}:${query.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suggestions;

    const sources: Array<Promise<PackageSuggestion[]>> = [];
    if (manager === 'auto' || manager === 'apt') sources.push(this.apt(query).catch(() => []));
    if (manager === 'auto' || manager === 'npm') sources.push(this.npm(query).catch(() => []));
    if (manager === 'auto' || manager === 'uv' || manager === 'pip') {
      const target: InstallManager = manager === 'auto' ? 'pip' : manager;
      sources.push(this.pypi(query)
        .then((rows) => rows.map((row) => ({ ...row, manager: target })))
        .catch(() => []));
    }
    if (manager === 'aqua') sources.push(this.github(query).catch(() => []));

    const collected = (await Promise.all(sources)).flat();
    const unique = new Map<string, PackageSuggestion>();
    for (const suggestion of collected) {
      const key = `${suggestion.manager}:${suggestion.name.toLowerCase()}`;
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
