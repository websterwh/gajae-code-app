import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CATALOG_URL,
  attachGitHubStars,
  bundledCatalog,
  loadOverlay,
  mergeCatalog,
  normalizeCatalogEntry,
  searchCatalog,
  type CatalogEntry,
} from './catalog.js';
import { createRegistryClient } from './registry-client.js';

test('the bundled catalog works with no network and carries mount requirements', () => {
  const entries = bundledCatalog();
  assert.ok(entries.length >= 10);
  const filesystem = entries.find((entry) => entry.name === 'filesystem');
  assert.equal(filesystem?.transport, 'stdio');
  assert.ok(filesystem?.requires?.mounts?.length);
  assert.ok(entries.every((entry) => entry.source === 'bundled'));
});

test('an overlay replaces entries by name and a registry entry never replaces a curated one', () => {
  const baseline = [normalizeCatalogEntry({ name: 'one', transport: 'stdio', command: 'one' }, 'bundled')!];
  const overlay = [normalizeCatalogEntry({ name: 'one', transport: 'stdio', command: 'one-new', description: 'overlay' }, 'overlay')!];
  const registry = [
    normalizeCatalogEntry({ name: 'one', transport: 'stdio', command: 'registry' }, 'registry')!,
    normalizeCatalogEntry({ name: 'two', transport: 'stdio', command: 'two' }, 'registry')!,
  ];
  const merged = mergeCatalog(baseline, overlay, registry);
  assert.equal(merged.find((entry) => entry.name === 'one')?.command, 'one-new');
  assert.equal(merged.find((entry) => entry.name === 'two')?.source, 'registry');
  assert.equal(searchCatalog(merged, 'overlay').length, 1);
});

test('the bundled catalog is a large, valid, deduplicated index with the named servers', async () => {
  const entries = bundledCatalog();
  assert.ok(entries.length >= 150, `expected 150+ entries, got ${entries.length}`);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length, 'names must be unique');

  for (const entry of entries) {
    if (entry.transport === 'stdio') assert.ok(entry.command, `${entry.name} needs a command`);
    else assert.ok(entry.url, `${entry.name} needs a url`);
    if (entry.package) {
      assert.ok(['npm', 'pypi', 'git', 'other'].includes(entry.package.manager), `${entry.name} package manager`);
      assert.ok(entry.package.name, `${entry.name} package name`);
    }
  }

  assert.ok(entries.some((entry) => entry.name === 'context7'));
  assert.ok(entries.some((entry) => entry.name === 'mempalace'));

  const deploy = JSON.parse(await readFile(new URL('../../../deploy/mcp/catalog.json', import.meta.url), 'utf8')) as unknown[];
  assert.ok(Array.isArray(deploy) && deploy.length >= 150);
});

test('the default overlay URL points at a generated file that exists in the repo', async () => {
  const url = new URL(DEFAULT_CATALOG_URL);
  assert.ok(url.pathname.endsWith('/deploy/mcp/catalog.json'));
  const file = JSON.parse(await readFile(new URL('../../../deploy/mcp/catalog.json', import.meta.url), 'utf8')) as unknown[];
  assert.ok(file.length > 0);
});

test('ranking puts curated Context7 above forks and namespaced lookalikes', () => {
  const curated = normalizeCatalogEntry({
    name: 'context7', title: 'Context7', description: 'Up-to-date library documentation.',
    transport: 'stdio', command: 'npx',
  }, 'bundled')!;
  const fork = normalizeCatalogEntry({
    name: 'ai.smithery/renCosta2025-context7fork', title: 'Context7 fork',
    description: 'A context7 fork', transport: 'stdio', command: 'npx',
  }, 'registry')!;
  const paid = normalizeCatalogEntry({
    name: 'com.clauxel.context7docs/mcp', title: 'Context7 Docs paid',
    description: 'Paid context7 docs', transport: 'stdio', command: 'npx',
  }, 'registry')!;

  assert.equal(searchCatalog([fork, paid, curated], 'context7')[0]?.name, 'context7');
  assert.equal(searchCatalog([fork, paid, curated], 'context 7')[0]?.name, 'context7');
  assert.equal(searchCatalog([fork, paid, curated], 'context-7')[0]?.name, 'context7');
});

test('a registry duplicate of a curated title or package is collapsed', () => {
  const curated = normalizeCatalogEntry({
    name: 'context7', title: 'Context7', description: 'Docs', transport: 'stdio', command: 'npx',
    package: { manager: 'npm', name: '@upstash/context7-mcp' },
  }, 'bundled')!;
  const byTitle = normalizeCatalogEntry({
    name: 'io.upstash/context7', title: 'Context7', description: 'Registry copy',
    transport: 'stdio', command: 'npx',
  }, 'registry')!;
  const byPackage = normalizeCatalogEntry({
    name: 'some-other-name', title: 'Some other', description: 'Registry copy',
    transport: 'stdio', command: 'npx', package: { manager: 'npm', name: '@upstash/context7-mcp' },
  }, 'registry')!;
  const merged = mergeCatalog([curated], [], [byTitle, byPackage]);
  assert.deepEqual(merged.map((entry) => entry.name).sort(), ['context7']);
});

test('stars are fetched best-effort, cached, bounded, and never fatal', async () => {
  const entry = (name: string, repo: string): CatalogEntry => normalizeCatalogEntry({
    name, description: name, transport: 'stdio', command: 'npx', repository: { url: `https://github.com/${repo}` },
  }, 'registry')!;

  let calls = 0;
  const fetchImpl = (async (url: string | URL) => {
    calls += 1;
    assert.match(String(url), /api\.github\.com\/repos\/acme\/one/u);
    return new Response(JSON.stringify({ stargazers_count: 12_300 }), { status: 200 });
  }) as unknown as typeof fetch;
  const [starred] = await attachGitHubStars([entry('one', 'acme/one')], { fetchImpl, now: () => 0 });
  assert.equal(starred?.stars, 12_300);
  const [cached] = await attachGitHubStars([entry('one', 'acme/one')], { fetchImpl, now: () => 1_000 });
  assert.equal(cached?.stars, 12_300);
  assert.equal(calls, 1, 'a fresh cache must not spend a request');

  const many = Array.from({ length: 10 }, (_, index) => entry(`server-${index}`, `acme/repo-${index}`));
  let boundedCalls = 0;
  const boundedFetch = (async () => {
    boundedCalls += 1;
    return new Response(JSON.stringify({ stargazers_count: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await attachGitHubStars(many, { fetchImpl: boundedFetch, now: () => 10, limit: 3 });
  assert.equal(boundedCalls, 3, 'lookups per response are capped');

  const failing = (async () => { throw new Error('rate limited'); }) as unknown as typeof fetch;
  const unchanged = await attachGitHubStars([entry('offline', 'acme/offline')], { fetchImpl: failing, now: () => 0 });
  assert.equal(unchanged[0]?.stars, undefined);
});

test('a malformed overlay is ignored with a warning, and a valid one is cached', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheFile = join(root, 'catalog-cache.json');

  const malformed = async () => new Response(JSON.stringify({ not: 'a list' }), { status: 200 });
  const broken = await loadOverlay({ url: 'https://example.test/catalog.json', fetchImpl: malformed as unknown as typeof fetch, cacheFile });
  assert.deepEqual(broken.entries, []);
  assert.match(String(broken.warning), /not a server list/u);

  const valid = async () => new Response(JSON.stringify({
    servers: [{ name: 'project-extra', description: 'from the overlay', transport: 'stdio', command: 'node' }],
  }), { status: 200, headers: { etag: '"abc"' } });
  const loaded = await loadOverlay({ url: 'https://example.test/catalog.json', fetchImpl: valid as unknown as typeof fetch, cacheFile });
  assert.equal(loaded.entries[0]?.name, 'project-extra');
  assert.equal(loaded.entries[0]?.source, 'overlay');

  // Fresh cache: no second request is needed.
  let called = false;
  const shouldNotRun = async () => { called = true; return new Response('{}', { status: 500 }); };
  const cached = await loadOverlay({ url: 'https://example.test/catalog.json', fetchImpl: shouldNotRun as unknown as typeof fetch, cacheFile });
  assert.equal(called, false);
  assert.equal(cached.entries[0]?.name, 'project-extra');
});

test('the registry client paginates, maps packages, keeps the repository and rejects short searches', async () => {
  let requested = '';
  const response = {
    servers: [{
      server: {
        name: 'io.test/one',
        description: 'one',
        repository: { url: 'https://github.com/acme/one', source: 'github' },
        packages: [{
          registryType: 'npm',
          identifier: 'one-mcp',
          version: '1.2.3',
          environmentVariables: [{ name: 'TOKEN', isRequired: true, isSecret: true }],
        }],
      },
    }],
    metadata: { nextCursor: 'next-1' },
  };
  const fetchImpl = (async (url: string | URL) => {
    requested = String(url);
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createRegistryClient({ baseUrl: 'https://registry.test/servers', fetchImpl });

  const result = await client.search({ search: 'one', limit: 5 });
  assert.equal(result.entries[0]?.name, 'io.test/one');
  assert.equal(result.entries[0]?.source, 'registry');
  assert.equal(result.entries[0]?.command, 'npx');
  assert.equal(result.entries[0]?.env?.[0]?.secret, true);
  assert.equal(result.entries[0]?.repository?.url, 'https://github.com/acme/one');
  assert.equal(result.nextCursor, 'next-1');
  assert.match(requested, /search=one/u);
  assert.match(requested, /version=latest/u);
  assert.match(requested, /limit=5/u);

  await assert.rejects(client.search({ search: 'on' }), /at least 3 characters/u);
});
