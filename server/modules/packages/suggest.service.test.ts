import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CommandRunner } from '../mcp/index.js';

import { PackageSuggestService } from './suggest.service.js';

const offline = async (): Promise<never> => { throw new Error('offline'); };

type AptPackage = { name: string; description: string };

/**
 * A stand-in for the real index: apt is only fast when descriptions are read
 * from `dumpavail` once instead of scanned per query, and these fakes mirror
 * both commands so a test never depends on which one answered.
 */
const APT_PACKAGES: AptPackage[] = [
  { name: 'zoxide', description: 'A smarter cd command' },
  { name: 'zoxide-doc', description: 'Documentation for zoxide' },
  { name: 'vim-zoxide', description: 'zoxide integration for Vim' },
  { name: 'fzf', description: 'general-purpose command-line fuzzy finder' },
  { name: 'gh', description: 'GitHub CLI, GitHub’s official command line tool' },
  { name: 'golang-github-dgraph-io-badger-dev', description: 'Fast key-value DB in Go' },
];

const dumpavailOf = (packages: AptPackage[]): string => packages
  .map((pkg) => `Package: ${pkg.name}\nDescription: ${pkg.description}\nDescription-md5: 0000\n`)
  .join('\n');

const namesOnlyOf = (packages: AptPackage[], query: string): string => packages
  .filter((pkg) => pkg.name.toLowerCase().includes(query.toLowerCase()))
  .map((pkg) => `${pkg.name} - ${pkg.description}`)
  .join('\n');

const aptRunner = (calls: string[] = [], packages = APT_PACKAGES): CommandRunner => async (command, args) => {
  calls.push([command, ...args].join(' '));
  if (command === 'apt-get') return { code: 0, stdout: '', stderr: '' };
  if (command !== 'apt-cache') return { code: 1, stdout: '', stderr: 'not found' };
  if (args[0] === 'dumpavail') return { code: 0, stdout: dumpavailOf(packages), stderr: '' };
  const query = args[1] === '--names-only' ? args[2] ?? '' : args[1] ?? '';
  return { code: 0, stdout: namesOnlyOf(packages, query), stderr: '' };
};

describe('package suggestions', () => {
  test('merges apt, npm and PyPI and ranks name prefixes first', async () => {
    const service = new PackageSuggestService({
      runner: aptRunner(),
      fetchImpl: async (url) => {
        if (url.includes('registry.npmjs.org')) {
          return { ok: true, json: async () => ({ objects: [{ package: { name: 'zoxide', description: 'npm wrapper' } }] }) };
        }
        return { ok: true, json: async () => ({ info: { name: 'zoxide', summary: 'pypi wrapper' } }) };
      },
    });

    const suggestions = await service.suggest('zox');

    // Prefix matches first; a name that merely embeds the query sorts last.
    assert.deepEqual(suggestions.map((suggestion) => `${suggestion.manager}:${suggestion.name}`), [
      'apt:zoxide',
      'npm:zoxide',
      'pip:zoxide',
      'apt:zoxide-doc',
      'apt:vim-zoxide',
    ]);
  });

  test('apt finds a package whose description names the query', async () => {
    const calls: string[] = [];
    const service = new PackageSuggestService({ runner: aptRunner(calls), fetchImpl: offline });

    // The table loads behind the first answer, so the second query is the one
    // that can read descriptions.
    await service.suggest('githu', 'apt');
    await service.whenAptIndexSettled();
    const suggestions = await service.suggest('github', 'apt');

    // `gh` is not named github; its description is what makes it the answer.
    assert.equal(suggestions[0]?.name, 'gh');
    // The full description scan took 68-73s; dumpavail replaced it entirely.
    assert.equal(calls.some((call) => /apt-cache search github$/u.test(call)), false, calls.join(', '));
  });

  test('apt descriptions match any package, not just the ones named github', async () => {
    const service = new PackageSuggestService({ runner: aptRunner(), fetchImpl: offline });
    await service.suggest('zzz', 'apt');
    await service.whenAptIndexSettled();

    // Neither word is in the package name; only its description knows it.
    const suggestions = await service.suggest('fuzzy finder', 'apt');
    assert.deepEqual(suggestions.map((suggestion) => suggestion.name), ['fzf']);
  });

  test('the apt table is loaded once and every later query reads memory', async () => {
    const calls: string[] = [];
    const service = new PackageSuggestService({ runner: aptRunner(calls), fetchImpl: offline });

    await service.suggest('zox', 'apt');
    await service.whenAptIndexSettled();
    assert.equal(calls.filter((call) => call === 'apt-cache dumpavail').length, 1);

    calls.length = 0;
    await service.suggest('gh', 'apt');
    await service.suggest('vim', 'apt');

    // No subprocess per keystroke: the table answers both.
    assert.deepEqual(calls, []);
  });

  test('a source that is offline does not empty the whole list', async () => {
    const service = new PackageSuggestService({ runner: aptRunner(), fetchImpl: offline });
    const suggestions = await service.suggest('zox');
    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((suggestion) => suggestion.manager === 'apt'));
  });

  test('one character is not a search', async () => {
    let called = false;
    const service = new PackageSuggestService({
      runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
      fetchImpl: offline,
    });
    assert.deepEqual(await service.suggest('z'), []);
    assert.equal(called, false);
  });

  test('choosing aqua searches GitHub releases and nothing else', async () => {
    let aptCalls = 0;
    const service = new PackageSuggestService({
      runner: async () => { aptCalls += 1; return { code: 0, stdout: '', stderr: '' }; },
      fetchImpl: async (url) => {
        assert.match(url, /api\.github\.com\/search\/repositories/u);
        assert.match(url, /q=github%20in%3Aname/u);
        return {
          ok: true,
          json: async () => ({
            items: [
              { full_name: 'cli/cli', description: 'GitHub’s official command line tool' },
              { full_name: 'dead/repo', archived: true },
              { full_name: 'not-a-repo', description: 'no owner' },
            ],
          }),
        };
      },
    });

    const suggestions = await service.suggest('github', 'aqua');

    assert.deepEqual(suggestions.map((suggestion) => `${suggestion.manager}:${suggestion.name}`), ['aqua:cli/cli']);
    assert.equal(aptCalls, 0);
  });

  test('a saved GitHub token authenticates the aqua search, and its absence does not', async () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    const headers = async () => {
      let authorization: string | undefined;
      const service = new PackageSuggestService({
        fetchImpl: async (_url, init) => {
          authorization = init?.headers?.authorization;
          return { ok: true, json: async () => ({ items: [{ full_name: 'cli/cli', description: 'GitHub CLI' }] }) };
        },
      });
      await service.suggest('gh', 'aqua');
      return authorization;
    };

    try {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      assert.equal(await headers(), undefined);

      // Anonymous search is rate-limited to ten requests a minute; a token
      // lifts that to thirty, which is the whole reason it is sent.
      process.env.GITHUB_TOKEN = 'ghp_savedtokenvalue';
      assert.equal(await headers(), 'Bearer ghp_savedtokenvalue');
    } finally {
      for (const key of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('auto searches GitHub for aqua too, so github finds the CLI', async () => {
    const service = new PackageSuggestService({
      runner: async () => ({ code: 0, stdout: 'gh - GitHub CLI, cli.github.com\n', stderr: '' }),
      fetchImpl: async (url) => {
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({ items: [{ full_name: 'github/hub', description: 'A command-line tool that makes git easier' }] }),
          };
        }
        return { ok: false, json: async () => ({}) };
      },
    });

    const suggestions = await service.suggest('github');

    // `gh` answers on its description, the repository on its name; only those
    // two sources had anything to say.
    assert.deepEqual(
      suggestions.map((suggestion) => `${suggestion.manager}:${suggestion.name}`).sort(),
      ['apt:gh', 'aqua:github/hub'],
    );
  });

  /*
   * The pruned image's index answers every search with nothing and exit 0. The
   * rebuild costs a network update plus a minute of decompression, so it runs
   * behind the answer: the search that notices the empty index still returns,
   * and the one after it sees apt.
   */

  test('an empty apt index is rebuilt in the background, not in front of the answer', async () => {
    const calls: string[] = [];
    let indexed = false;
    const service = new PackageSuggestService({
      fetchImpl: offline,
      runner: async (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === 'apt-get') {
          indexed = true;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: indexed && args[1] !== 'github' ? 'gh - GitHub CLI, cli.github.com\n' : '', stderr: '' };
      },
    });

    assert.deepEqual(await service.suggest('github', 'apt'), []);
    await service.whenAptIndexSettled();
    assert.deepEqual(calls, [
      'apt-cache dumpavail',
      'apt-cache search --names-only github',
      'apt-get update -qq',
      'apt-cache dumpavail',
    ]);

    const suggestions = await service.suggest('gh', 'apt');
    assert.equal(suggestions[0]?.name, 'gh');

    // The rebuild happens once; later searches read the index directly.
    calls.length = 0;
    await service.suggest('git', 'apt');
    assert.deepEqual(calls, ['apt-cache search --names-only git']);
  });

  test('a hung apt search does not hold back the sources that answered', async () => {
    const service = new PackageSuggestService({
      aptBudgetMs: 20,
      runner: async (command) => {
        if (command !== 'apt-cache') return { code: 1, stdout: '', stderr: '' };
        // apt-cache decompressing a cold index: never finishes in this test.
        return new Promise(() => undefined);
      },
      fetchImpl: async (url) => {
        if (!url.includes('registry.npmjs.org')) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ objects: [{ package: { name: 'gh', description: 'Node wrapper' } }] }) };
      },
    });

    const started = Date.now();
    const suggestions = await service.suggest('gh');

    assert.deepEqual(suggestions.map((suggestion) => `${suggestion.manager}:${suggestion.name}`), ['npm:gh']);
    assert.ok(Date.now() - started < 1_000, 'apt held the response');
  });

  test('one source cannot fill the list with its own wrappers', async () => {
    const prefixes = ['github-a', 'github-b', 'github-c', 'github-d', 'github-e', 'github-f'];
    const service = new PackageSuggestService({
      runner: async () => ({
        code: 0,
        // What apt actually returns: a package named after the query, then the
        // CLI that describes itself as it, then the Go bindings.
        stdout: [
          'github-backup - backup a github account',
          'gh - GitHub CLI, cli.github.com',
          ...prefixes.map((name) => `golang-${name}-dev - A Go binding`),
        ].join('\n'),
        stderr: '',
      }),
      fetchImpl: async (url) => {
        if (url.includes('registry.npmjs.org')) {
          return {
            ok: true,
            json: async () => ({ objects: prefixes.map((name) => ({ package: { name, description: 'GitHub wrapper' } })) }),
          };
        }
        if (url.includes('pypi.org')) {
          return { ok: true, json: async () => ({ info: { name: 'github', summary: 'PyPI client' } }) };
        }
        return {
          ok: true,
          json: async () => ({ items: [{ full_name: 'github/hub', description: 'A command-line tool that makes git easier' }] }),
        };
      },
    });

    const suggestions = await service.suggest('github');
    const key = (manager: string, name: string) => `${manager}:${name}`;
    const listed = suggestions.map((suggestion) => key(suggestion.manager, suggestion.name));

    // Twelve prefix-named wrappers would otherwise fill every slot and bury
    // the answers that score on their description or an embedded name.
    assert.ok(listed.length <= 12, `${listed.length} suggestions`);
    assert.ok(listed.includes('pip:github'), `missing the PyPI package in ${listed.join(', ')}`);
    assert.ok(listed.includes('apt:gh'), `missing gh in ${listed.join(', ')}`);
    assert.ok(listed.includes('aqua:github/hub'), `missing the release in ${listed.join(', ')}`);
  });

  test('choosing uv installs through uv, not pip', async () => {
    const service = new PackageSuggestService({
      runner: aptRunner(),
      fetchImpl: async (url) => {
        assert.ok(url.includes('pypi.org'), `unexpected source ${url}`);
        return { ok: true, json: async () => ({ info: { name: 'serena', summary: 'semantic code toolkit' } }) };
      },
    });

    const [suggestion] = await service.suggest('serena', 'uv');

    assert.equal(suggestion?.manager, 'uv');
    assert.equal(suggestion?.spec, 'serena');
  });

  test('the manager is part of the cache key', async () => {
    let pypiCalls = 0;
    const service = new PackageSuggestService({
      runner: aptRunner(),
      fetchImpl: async (url) => {
        if (url.includes('registry.npmjs.org')) {
          return { ok: true, json: async () => ({ objects: [{ package: { name: 'serena-cli', description: '' } }] }) };
        }
        if (url.includes('pypi.org')) pypiCalls += 1;
        return { ok: true, json: async () => ({ info: { name: 'serena', summary: '' } }) };
      },
    });

    await service.suggest('serena', 'pip');
    const auto = await service.suggest('serena');

    // A filtered list (pip only) must not be served for "search everything".
    assert.equal(pypiCalls, 2);
    assert.ok(auto.some((suggestion) => suggestion.manager === 'npm'));
  });
});
