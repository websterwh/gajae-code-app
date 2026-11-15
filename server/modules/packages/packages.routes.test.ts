import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import express from 'express';

import { createPackagesRouter } from './packages.routes.js';
import type { PackagesService } from './packages.service.js';

test('the packages router maps validation errors to 400 and conflicts to 409', async (t) => {
  const service = {
    list: async () => [],
    add: async () => {
      throw new Error('manager must be one of uv, pip, npm or aqua.');
    },
    setPin: async (manager: string) => {
      // An aqua package cannot be pinned at all, so this is bad input, not a
      // conflict with the current state.
      if (manager === 'aqua') throw new Error('GitHub release packages cannot be pinned to a version.');
      throw new Error('Package provisioning is already running. Try again when it finishes.');
    },
    upgrade: async () => {
      throw new Error('Package was not found.');
    },
    remove: async () => undefined,
  } as unknown as PackagesService;

  const app = express();
  app.use(express.json());
  app.use('/api/packages', createPackagesRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/packages`;

  const list = await fetch(base);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { data: unknown[] }).data, []);

  const badManager = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manager: 'brew', spec: 'wget' }),
  });
  assert.equal(badManager.status, 400);

  const aquaPin = await fetch(`${base}/aqua/skylot%2Fjadx`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '1.4.7' }),
  });
  assert.equal(aquaPin.status, 400, 'an unpinnable package is a bad request, not a conflict');

  const busy = await fetch(`${base}/npm/cowsay`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: null }),
  });
  assert.equal(busy.status, 409);

  const missing = await fetch(`${base}/npm/ghost/upgrade`, { method: 'POST' });
  assert.equal(missing.status, 404);

  const removed = await fetch(`${base}/npm/cowsay`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
});
