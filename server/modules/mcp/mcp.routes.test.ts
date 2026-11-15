import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createMcpRouter } from './mcp.routes.js';
import { McpService } from './mcp.service.js';

test('the MCP router validates input and serves the bundled catalog offline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new McpService({
    agentDir: root,
    runCli: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    catalogCachePath: join(root, 'catalog-cache.json'),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/mcp`;

  const list = await fetch(`${base}/servers`);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { data: unknown[] }).data, []);

  const invalid = await fetch(`${base}/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'no-command', transport: 'stdio' }),
  });
  assert.equal(invalid.status, 400);
  assert.match(JSON.stringify(await invalid.json()), /needs a command/u);

  const missing = await fetch(`${base}/servers/nope?scope=global`);
  assert.equal(missing.status, 404);

  const badScope = await fetch(`${base}/servers?scope=elsewhere`);
  assert.equal(badScope.status, 400);

  const badSort = await fetch(`${base}/catalog?sort=stars`);
  assert.equal(badSort.status, 400);
  assert.match(JSON.stringify(await badSort.json()), /sort must be name, relevance or popularity/u);

  const catalog = await fetch(`${base}/catalog?source=bundled`);
  assert.equal(catalog.status, 200);
  const body = await catalog.json() as { data: { entries: Array<{ name: string; source: string }>; warning?: string } };
  assert.ok(body.data.entries.length >= 10);
  assert.ok(body.data.entries.every((entry) => entry.source === 'bundled'));
  assert.equal(typeof body.data.warning, 'string');
});
