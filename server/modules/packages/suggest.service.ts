import { spawnCommandRunner, type CommandRunner, type InstallManager } from '../mcp/index.js';

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
  /** How long an apt search may take before the other sources answer alone. */
  aptBudgetMs?: number;
  /** How long an explicit apt search may take, with no other source to answer. */
  aptOnlyBudgetMs?: number;
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
/**
 * apt decompresses its whole index per search, which on a cold or loaded
 * machine has been measured in tens of seconds. It runs beside three network
 * sources and the response waits for every one of them, so one slow local
 * lookup used to delay every suggestion by a minute. Past this budget apt
 * simply contributes nothing to this answer.
 */
const APT_SEARCH_BUDGET_MS = 4_000;
/**
 * Picking apt narrowed the search to one source, so there is nothing else to
 * answer while apt works; cutting it short would report "no matches" for a
 * package that exists. The budget only has to stop an unbounded hang.
 */
const APT_ONLY_BUDGET_MS = 20_000;
/** A rebuild that failed is retried at most this often, never per keystroke. */
const APT_INDEX_RETRY_MS = 60_000;
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

/** Resolves to null instead of waiting longer than `ms` for `promise`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class PackageSuggestService {
  private readonly timeoutMs: number;
  private readonly aptBudgetMs: number;
  private readonly aptOnlyBudgetMs: number;
  private readonly runner: CommandRunner;
  /** Set once a rebuild succeeded; see `warmAptIndex`. */
  private aptIndexBuilt = false;
  private aptIndexWarm: Promise<void> | null = null;
  private aptIndexAttemptAt = 0;
  private readonly cache = new Map<string, { at: number; suggestions: PackageSuggestion[] }>();

  constructor(private readonly options: SuggestOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.aptBudgetMs = options.aptBudgetMs ?? APT_SEARCH_BUDGET_MS;
    this.aptOnlyBudgetMs = options.aptOnlyBudgetMs ?? APT_ONLY_BUDGET_MS;
    // apt is the one source read from a process, not a URL. Defaulting it to
    // the shared runner is what makes the exported service search apt at all:
    // with only an optional runner, the singleton had none and apt silently
    // contributed nothing to every query.
    this.runner = options.runner ?? spawnCommandRunner();
  }

  private fetcher(): FetchLike {
    return this.options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private aptRows(stdout: string, query: string): PackageSuggestion[] {
    const suggestions: PackageSuggestion[] = [];
    for (const line of stdout.split(/\r?\n/u).slice(0, APT_SCAN_LIMIT)) {
      const separator = line.indexOf(' - ');
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (!PACKAGE_NAME.test(name)) continue;
      suggestions.push({ manager: 'apt', name, spec: name, description: line.slice(separator + 3).trim() });
    }
    return suggestions.sort(prefixFirst(query)).slice(0, APT_LIMIT);
  }

  /**
   * Rebuilds the pruned package index in the background.
   *
   * The image deletes /var/lib/apt/lists to keep its layers small, and an empty
   * index answers `apt-cache search` with no output and exit 0 - the same thing
   * it does for a name that does not exist. The update takes a network round
   * trip and a minute of decompression, so a search never waits for it: the
   * first queries answer from npm, PyPI and GitHub, and the next ones also see
   * apt. Only a successful rebuild sticks; a failed one is retried after a
   * cooldown rather than on every keystroke.
   */
  private warmAptIndex(): void {
    if (this.aptIndexBuilt || this.aptIndexWarm) return;
    if (Date.now() - this.aptIndexAttemptAt < APT_INDEX_RETRY_MS) return;
    this.aptIndexAttemptAt = Date.now();
    this.aptIndexWarm = this.runner('apt-get', ['update', '-qq'])
      .then((result) => {
        if (result.code === 0) this.aptIndexBuilt = true;
      })
      .catch(() => undefined)
      .finally(() => {
        this.aptIndexWarm = null;
      });
    void this.aptIndexWarm;
  }

  private async apt(query: string, budgetMs: number): Promise<PackageSuggestion[]> {
    // Local and offline, once the index exists. Not `--names-only`: `github` is
    // a name nobody ships, but `gh` describes itself as the GitHub CLI, which is
    // what the user was looking for. Bounded, because the answer must not wait
    // on apt while three faster sources already have results.
    const result = await within(
      this.runner('apt-cache', ['search', query]),
      budgetMs,
    );
    if (!result || result.code !== 0) return [];
    const rows = this.aptRows(result.stdout, query);
    if (rows.length > 0 || this.aptIndexBuilt) return rows;

    this.warmAptIndex();
    return [];
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
   * `auto` searches every source, GitHub included, so a name it only knows as
   * a release shows up beside the npm and PyPI ones. A chosen manager searches
   * only itself, so picking `aqua` cannot answer with npm packages; uv and pip
   * are both PyPI, so the selected one is the manager the suggestion installs
   * through.
   */
  /** Test seam: settle the background index rebuild, if one is running. */
  async whenAptIndexSettled(): Promise<void> {
    await this.aptIndexWarm;
  }

  async suggest(rawQuery: string, manager: SuggestManager = 'auto'): Promise<PackageSuggestion[]> {
    const query = rawQuery.trim();
    // One character matches half the index and costs three round trips.
    if (query.length < 2) return [];
    const cacheKey = `${manager}:${query.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suggestions;

    const sources: Array<Promise<PackageSuggestion[]>> = [];
    if (manager === 'auto' || manager === 'apt') {
      sources.push(this.apt(query, manager === 'apt' ? this.aptOnlyBudgetMs : this.aptBudgetMs).catch(() => []));
    }
    if (manager === 'auto' || manager === 'npm') sources.push(this.npm(query).catch(() => []));
    if (manager === 'auto' || manager === 'uv' || manager === 'pip') {
      const target: InstallManager = manager === 'auto' ? 'pip' : manager;
      sources.push(this.pypi(query)
        .then((rows) => rows.map((row) => ({ ...row, manager: target })))
        .catch(() => []));
    }
    // `auto` has to include this or the answer to `github` - the CLI and its
    // release - never appears beside the npm wrappers with the same name.
    if (manager === 'auto' || manager === 'aqua') sources.push(this.github(query).catch(() => []));

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
