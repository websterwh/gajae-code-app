import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bundledCatalog,
  loadOverlay,
  mergeCatalog,
  normalizeCatalogEntry,
  searchCatalog,
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

test('the registry client paginates, maps packages and rejects short searches', async () => {
  let requested = '';
  const response = {
    servers: [{
      server: {
        name: 'io.test/one',
        description: 'one',
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
  assert.equal(result.nextCursor, 'next-1');
  assert.match(requested, /search=one/u);
  assert.match(requested, /version=latest/u);
  assert.match(requested, /limit=5/u);

  await assert.rejects(client.search({ search: 'on' }), /at least 3 characters/u);
});
