import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('the bundled catalog is a real, valid, deduplicated index with the named servers', async () => {
  const entries = bundledCatalog();
  assert.ok(entries.length >= 60, `expected 60+ entries, got ${entries.length}`);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length, 'names must be unique');

  for (const entry of entries) {
    if (entry.origin !== 'curated') {
      assert.match(entry.name, /^[a-z0-9][a-z0-9_-]*$/u, `${entry.name} must not be a vendor namespace`);
    }
    if (entry.transport === 'stdio') assert.ok(entry.command, `${entry.name} needs a command`);
    else assert.ok(entry.url, `${entry.name} needs a url`);
    if (entry.transport !== 'stdio') assert.equal(entry.command, undefined, `${entry.name} must not carry a command`);
    if (entry.package) {
      assert.ok(['npm', 'pypi', 'git', 'other'].includes(entry.package.manager), `${entry.name} package manager`);
      assert.ok(entry.package.name, `${entry.name} package name`);
    }
  }

  const curated = JSON.parse(await readFile(new URL('../../../data/catalog.curated.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
  for (const name of ['context7', 'mempalace']) {
    const expected = curated.find((entry) => entry.name === name);
    const actual = entries.find((entry) => entry.name === name);
    assert.ok(expected, `${name} must stay curated`);
    assert.equal(actual?.origin, 'curated');
    assert.equal(actual?.command, expected.command, `${name} command`);
    assert.deepEqual(actual?.args, expected.args, `${name} args`);
    assert.equal(actual?.package?.name, (expected.package as { name?: string } | undefined)?.name, `${name} package`);
  }

  const remotes = entries.filter((entry) => entry.transport === 'http');
  assert.ok(remotes.length >= 5, `expected 5+ http entries, got ${remotes.length}`);
  assert.ok(remotes.every((entry) => entry.url && !entry.command), 'http entries need a url and no command');

  const deployText = await readFile(new URL('../../../deploy/mcp/catalog.json', import.meta.url), 'utf8');
  const overlayRaw = JSON.parse(deployText) as unknown;
  assert.ok(Array.isArray(overlayRaw) && overlayRaw.length > 0, 'the overlay must be a non-empty catalog list');
  const overlay = overlayRaw.map((entry, index) => {
    const normalized = normalizeCatalogEntry(entry, 'overlay');
    assert.ok(normalized, `overlay entry ${index} must be a valid catalog entry`);
    return normalized;
  });
  // The overlay is how the list grows without a new image, so it must carry
  // every bundled name and may carry names the bundled copy does not have.
  const overlayNames = new Set(overlay.map((entry) => entry.name));
  for (const entry of entries) {
    assert.ok(overlayNames.has(entry.name), `the overlay lost the bundled name ${entry.name}`);
  }
});

test('an overlay-only server survives the merge without relabelling bundled entries', () => {
  const bundled = normalizeCatalogEntry({ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, 'bundled')!;
  const mirrored = normalizeCatalogEntry({ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], description: 'mirror' }, 'overlay')!;
  const extra = normalizeCatalogEntry({
    name: 'team-docs', description: 'Overlay only.', transport: 'stdio', command: 'npx', args: ['-y', 'team-docs'],
  }, 'overlay')!;
  const merged = mergeCatalog([bundled], [mirrored, extra]);
  assert.equal(merged.find((entry) => entry.name === 'filesystem')?.source, 'bundled');
  assert.equal(merged.find((entry) => entry.name === 'team-docs')?.source, 'overlay');
});

test('no bundled package name carries a version or dist-tag', () => {
  for (const entry of bundledCatalog()) {
    const name = entry.package?.name ?? '';
    const unscoped = name.startsWith('@') ? name.slice(1) : name;
    assert.ok(!unscoped.includes('@'), `${entry.name} package name must not carry a tag: ${name}`);
    assert.ok(!/[=<>~^]/u.test(name), `${entry.name} package name must not carry a version: ${name}`);
  }
});

test('the default overlay URL points at a generated file that exists in the repo', async () => {
  const url = new URL(DEFAULT_CATALOG_URL);
  assert.ok(url.pathname.endsWith('/deploy/mcp/catalog.json'));
  const file = JSON.parse(await readFile(new URL('../../../deploy/mcp/catalog.json', import.meta.url), 'utf8')) as unknown[];
  assert.ok(file.length > 0);
});

test('ranking prefers a curated entry over a higher-starred generated entry at the same tier', () => {
  const curated = normalizeCatalogEntry({
    name: 'curated-docs', title: 'Docs', description: 'Hand-picked docs.', origin: 'curated',
    transport: 'stdio', command: 'npx', stars: 1,
  }, 'bundled')!;
  const generated = normalizeCatalogEntry({
    name: 'generated-docs', title: 'Docs', description: 'Generated docs.', origin: 'marketplace',
    transport: 'stdio', command: 'npx', stars: 99_999,
  }, 'bundled')!;

  assert.equal(searchCatalog([generated, curated], 'docs')[0]?.name, 'curated-docs');
});

test('an exact registry name match beats a curated description match', () => {
  const curated = normalizeCatalogEntry({
    name: 'curated-data-tool', title: 'Data tool', description: 'A tool for redis data.',
    origin: 'curated', transport: 'stdio', command: 'npx',
  }, 'bundled')!;
  const registry = normalizeCatalogEntry({
    name: 'redis', title: 'Redis', description: 'Registry copy.', origin: 'registry',
    transport: 'stdio', command: 'npx',
  }, 'registry')!;

  assert.equal(searchCatalog([curated, registry], 'redis')[0]?.name, 'redis');
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

test('a mirrored overlay does not relabel bundled entries', () => {
  const bundled = normalizeCatalogEntry({ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, 'bundled')!;
  const mirrored = normalizeCatalogEntry({ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], description: 'same install' }, 'overlay')!;
  assert.equal(mergeCatalog([bundled], [mirrored])[0]?.source, 'bundled');
  const changed = normalizeCatalogEntry({ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg@2'] }, 'overlay')!;
  assert.equal(mergeCatalog([bundled], [changed])[0]?.source, 'overlay');
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

  let subtreeCalls = 0;
  const subtree = normalizeCatalogEntry({
    name: 'subtree', description: 'subtree', transport: 'stdio', command: 'npx',
    repository: { url: 'https://github.com/acme/monorepo/tree/main/src/subtree' },
  }, 'registry')!;
  await attachGitHubStars([subtree], {
    fetchImpl: (async () => { subtreeCalls += 1; return new Response('{}'); }) as unknown as typeof fetch,
    now: () => 0,
  });
  assert.equal(subtreeCalls, 0, 'a monorepo subdirectory must not borrow the repo count');
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

test('the generator refuses to write fewer than 60 entries and writes mirrored, origin-tagged output', async (t) => {
  const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const generator = fileURLToPath(new URL('../../../scripts/build-mcp-catalog.mjs', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'mcp-generator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seedFile = join(root, 'seed.json');
  await writeFile(seedFile, JSON.stringify({ servers: [] }), 'utf8');

  const marketplace = (count: number): { servers: unknown[] } => ({
    servers: Array.from({ length: count }, (_, index) => (index === 0
      ? { slug: 'ai.junk', name: 'Junk', install: { claudeDesktop: { command: 'npx', args: ['-y', 'junk'] } } }
      : index === 1
        ? {
            slug: 'fixture-remote', name: 'Fixture Remote', description: 'A remote fixture.', transports: ['http'],
            install: { remote: { url: 'https://mcp.example.test/mcp', type: 'http' } },
          }
        : index === 2
          ? {
              slug: 'fixture-tree', name: 'Fixture Tree', description: 'A monorepo fixture.', stars: 51_000,
              repo: 'https://github.com/acme/monorepo/tree/main/src/fixture-tree',
              install: { claudeDesktop: { command: 'npx', args: ['-y', 'fixture-tree'] } },
            }
          : {
              slug: `fixture-${index}`, name: `Fixture ${index}`, description: `Fixture ${index}.`,
              install: { claudeDesktop: { command: 'npx', args: ['-y', `fixture-pkg-${index}`] } },
            })),
  });

  const run = (count: number, output: string) => execFileSync(process.execPath, [generator], {
    cwd: appRoot,
    env: {
      ...process.env,
      CATALOG_MARKETPLACE_FILE: join(root, `marketplace-${count}.json`),
      CATALOG_SEED_FILE: seedFile,
      CATALOG_SKIP_DOCKER: '1',
      CATALOG_SKIP_REMOTE_CHECK: '1',
      CATALOG_SKIP_PACKAGE_CHECK: '1',
      CATALOG_OUTPUT_DIR: output,
    },
    stdio: 'pipe',
  });

  const shortOutput = join(root, 'short');
  await writeFile(join(root, 'marketplace-2.json'), JSON.stringify(marketplace(2)), 'utf8');
  assert.throws(() => run(2, shortOutput), (error: unknown) => (error as { status?: number }).status === 1);
  await assert.rejects(readFile(join(shortOutput, 'server/modules/mcp/catalog.data.json')), /ENOENT/u);

  const output = join(root, 'ok');
  await writeFile(join(root, 'marketplace-38.json'), JSON.stringify(marketplace(38)), 'utf8');
  run(38, output);
  const bundledText = await readFile(join(output, 'server/modules/mcp/catalog.data.json'), 'utf8');
  const deployText = await readFile(join(output, 'deploy/mcp/catalog.json'), 'utf8');
  assert.equal(deployText, bundledText);
  const entries = JSON.parse(bundledText) as CatalogEntry[];
  assert.equal(entries.length, 60);
  assert.ok(entries.every((entry) => entry.name !== 'ai.junk'));
  assert.equal(entries.find((entry) => entry.name === 'fixture-remote')?.url, 'https://mcp.example.test/mcp');
  assert.equal(entries.find((entry) => entry.name === 'fixture-remote')?.command, undefined);
  assert.equal(entries.find((entry) => entry.name === 'fixture-tree')?.stars, undefined);
  assert.equal(entries.find((entry) => entry.name === 'context7')?.origin, 'curated');
  assert.equal(entries.find((entry) => entry.name === 'fixture-3')?.origin, 'marketplace');
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
  assert.equal(result.entries[0]?.name, 'io.test-one', 'registry names must be installable');
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
