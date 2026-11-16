import assert from 'node:assert/strict';
import test from 'node:test';

import { createRegistryClient } from './registry-client.js';

test('latestVersion reads the npm dist-tag and the pypi info block over HTTP', async () => {
  const urls: string[] = [];
  const client = createRegistryClient({
    fetchImpl: (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const body = url.startsWith('https://registry.npmjs.org')
        ? { version: '0.0.85' }
        : { info: { version: '0.4.2' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });

  assert.equal(await client.latestVersion('npm', '@playwright/mcp'), '0.0.85');
  assert.equal(await client.latestVersion('pypi', 'mempalace'), '0.4.2');
  // Scoped names keep their slash, which is the path the registry expects.
  assert.deepEqual(urls, [
    'https://registry.npmjs.org/@playwright/mcp/latest',
    'https://pypi.org/pypi/mempalace/json',
  ]);
});

test('a registry that refuses is an absent version, not a crash', async () => {
  let calls = 0;
  const client = createRegistryClient({
    fetchImpl: (async () => {
      calls += 1;
      return new Response('nope', { status: 404 });
    }) as typeof fetch,
  });

  assert.equal(await client.latestVersion('npm', '@playwright/mcp'), null);
  // The miss is cached too: every list call would otherwise repeat it.
  assert.equal(await client.latestVersion('npm', '@playwright/mcp'), null);
  assert.equal(calls, 1);
});
