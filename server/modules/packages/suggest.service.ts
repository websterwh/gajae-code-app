import { spawnCommandRunner, type CommandRunner, type InstallManager } from '../mcp/index.js';

import { parseDumpavail, type AptEntry } from './apt-index.js';

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
 * apt cannot search descriptions quickly: `apt-cache search gh` scanned the
 * index in 68-73s on a warm cache, while `apt-cache search --names-only gh`
 * answered the same index in 1.1s. Descriptions are the cost, not the
 * decompression. It also runs beside three network sources whose answers used
 * to wait behind it, so the budget bounds the names-only fallback: the full
 * table is loaded in the background and replaces that pass.
 */
const APT_SEARCH_BUDGET_MS = 4_000;
/**
 * Picking apt narrowed the search to one source, so there is nothing else to
 * answer while apt works; cutting it short would report "no matches" for a
 * package that exists. The budget only has to stop an unbounded hang.
 */
const APT_ONLY_BUDGET_MS = 20_000;
/**
 * `apt-cache dumpavail` prints every stanza of the index in 1.6s here, which is
 * all a description search needs. The budget caps a hung dump rather than
 * leaving a half-loaded table pending forever.
 */
const APT_INDEX_LOAD_BUDGET_MS = 30_000;
/** An index rebuild or table load that failed is retried at most this often. */
const APT_INDEX_RETRY_MS = 60_000;
/**
 * A refined query (zox -> zoxid -> zoxide) hits the same sources twice, and so
 * does reopening the field on a name searched a moment ago. GitHub's anonymous
 * search allows ten requests a minute, so the cache is what keeps typing from
 * spending them.
 */
const CACHE_TTL_MS = 300_000;
const CACHE_LIMIT = 50;

/** A name is also the argument apt and pip will receive, so keep it to a name. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/iu;
/** `owner/repo`, the only spec shape the GitHub-release installer accepts. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/**
 * The Android SDK has no index to search: `sdkmanager --list` needs the
 * command-line tools installed first, which is exactly what a search is
 * looking for. The components worth naming are a short, stable set, so they
 * are listed here and matched by name or description.
 */
const ANDROID_PACKAGES: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'cmdline-tools;latest', description: 'Android SDK command-line tools: sdkmanager, avdmanager' },
  { name: 'platform-tools', description: 'Android platform tools: adb, fastboot' },
  { name: 'platforms;android-35', description: 'Android 15 SDK platform' },
  { name: 'build-tools;35.0.0', description: 'Android 15 build tools: aapt2, d8, apksigner' },
  { name: 'system-images;android-35;google_apis;x86_64', description: 'Android 15 emulator system image with Google APIs' },
];

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

/**
 * Every source that answered gets a place before any source gets a second one.
 * Ranking alone buried the answer to `github`: it matches dozens of npm and
 * GitHub packages whose names merely start with it, all of which outrank `gh`,
 * whose name has nothing to do with the query and only its description does.
 * Interleaving keeps that `gh` in the list instead of out of it.
 */
function interleave(ranked: PackageSuggestion[], limit: number): PackageSuggestion[] {
  const byManager = new Map<string, PackageSuggestion[]>();
  for (const suggestion of ranked) {
    const bucket = byManager.get(suggestion.manager);
    if (bucket) bucket.push(suggestion);
    else byManager.set(suggestion.manager, [suggestion]);
  }
  const buckets = [...byManager.values()];
  const ordered: PackageSuggestion[] = [];
  for (let round = 0; ordered.length < limit; round += 1) {
    const before = ordered.length;
    for (const bucket of buckets) {
      const next = bucket[round];
      if (!next || ordered.length >= limit) continue;
      ordered.push(next);
    }
    if (ordered.length === before) break;
  }
  return ordered;
}

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
  /** Every package apt knows, name and synopsis; null until the dump is read. */
  private aptIndex: AptEntry[] | null = null;
  private aptIndexLoad: Promise<void> | null = null;
  private aptIndexReload = false;
  private aptLoadAttemptAt = 0;
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
        if (result.code !== 0) return;
        this.aptIndexBuilt = true;
        // A rebuilt index is a new table: read it now instead of waiting for
        // the next search to notice the empty one.
        this.aptLoadAttemptAt = 0;
        this.loadAptIndex();
      })
      .catch(() => undefined)
      .finally(() => {
        this.aptIndexWarm = null;
      });
    void this.aptIndexWarm;
  }

  /**
   * Searches the in-memory table once it exists. Until then a names-only query
   * answers in about a second while that table loads behind it, so the first
   * `github` of a session cannot see `gh`'s description and the next keystroke
   * can; nothing ever waits on the multi-second description scan.
   */
  private async apt(query: string, budgetMs: number): Promise<PackageSuggestion[]> {
    if (this.aptIndex) return this.aptIndexRows(query);
    this.loadAptIndex();
    const result = await within(
      this.runner('apt-cache', ['search', '--names-only', query]),
      budgetMs,
    );
    if (!result || result.code !== 0) return [];
    const rows = this.aptRows(result.stdout, query);
    if (rows.length > 0 || this.aptIndexBuilt) return rows;

    this.warmAptIndex();
    return [];
  }

  /**
   * `--names-only` matches names alone, so the first search of a session would
   * never find `gh` for `github`. One `dumpavail` supplies the descriptions for
   * every later query in this process, and an empty answer means the image's
   * pruned index needs rebuilding rather than that nothing matched.
   */
  private loadAptIndex(): void {
    if (this.aptIndex) return;
    if (this.aptIndexLoad) {
      // A dump that started before the rebuild finished is stale; read the
      // index again once it clears instead of losing the rebuilt one.
      this.aptIndexReload = true;
      return;
    }
    if (Date.now() - this.aptLoadAttemptAt < APT_INDEX_RETRY_MS) return;
    this.aptLoadAttemptAt = Date.now();
    this.aptIndexLoad = within(this.runner('apt-cache', ['dumpavail']), APT_INDEX_LOAD_BUDGET_MS)
      .then((result) => {
        if (!result || result.code !== 0) return;
        const entries = parseDumpavail(result.stdout);
        if (entries.length === 0) {
          this.warmAptIndex();
          return;
        }
        this.aptIndex = entries;
      })
      .catch(() => undefined)
      .finally(() => {
        this.aptIndexLoad = null;
        if (!this.aptIndexReload) return;
        this.aptIndexReload = false;
        this.loadAptIndex();
      });
    void this.aptIndexLoad;
  }

  private aptIndexRows(query: string): PackageSuggestion[] {
    const needle = query.toLowerCase();
    const suggestions: PackageSuggestion[] = [];
    for (const entry of this.aptIndex ?? []) {
      const name = entry.name.toLowerCase();
      if (!name.includes(needle) && !entry.description.toLowerCase().includes(needle)) continue;
      suggestions.push({ manager: 'apt', name: entry.name, spec: entry.name, description: entry.description });
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

  private android(query: string): PackageSuggestion[] {
    const needle = query.toLowerCase();
    return ANDROID_PACKAGES
      .filter((pkg) => pkg.name.toLowerCase().includes(needle) || pkg.description.toLowerCase().includes(needle))
      .slice(0, NPM_LIMIT)
      .map((pkg) => ({ manager: 'android' as const, name: pkg.name, spec: pkg.name, description: pkg.description }));
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
  /** Test seam: settle the background index rebuild and table load, if any. */
  async whenAptIndexSettled(): Promise<void> {
    for (;;) {
      const pending = this.aptIndexWarm ?? this.aptIndexLoad;
      if (!pending) return;
      await pending;
    }
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
    if (manager === 'auto' || manager === 'android') sources.push(this.android(query));
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
    const suggestions = interleave([...unique.values()].sort(prefixFirst(query)), TOTAL_LIMIT);
    this.cache.set(cacheKey, { at: Date.now(), suggestions });
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return suggestions;
  }
}

export const packageSuggestService = new PackageSuggestService();
