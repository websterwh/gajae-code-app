import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { dockerClient, DockerSocketError, isContainerName, type HostControlClient } from './docker-socket.js';
import { createHostControlRouter, type HostControlStore } from './host-control.routes.js';
import {
  applyHostControlPatch,
  DEFAULT_HOST_CONTROL_SETTINGS,
  type HostControlSettings,
} from './host-control.settings.js';

const ENABLED_ENV = { GAJAE_HOST_CONTROL: '1' } as NodeJS.ProcessEnv;

function fakeStore(initial: Partial<HostControlSettings> = {}): HostControlStore {
  let settings: HostControlSettings = { ...DEFAULT_HOST_CONTROL_SETTINGS, ...initial };
  return {
    read: () => settings,
    write: (patch) => {
      settings = applyHostControlPatch(settings, patch);
      return settings;
    },
  };
}

function fakeClient(calls: string[]) {
  return {
    async ping() { calls.push('ping'); return true; },
    async info() {
      calls.push('info');
      return {
        serverVersion: '29.9.3', operatingSystem: 'Linux', kernelVersion: '6.18.22', ncpu: 4,
        memTotal: 1024, containers: 2, containersRunning: 1, containersStopped: 1, images: 3,
      };
    },
    async list() {
      calls.push('list');
      return [{ id: 'abcdef123456', name: 'gajae-app', image: 'ghcr.example/gajae', state: 'running', status: 'Up 3 hours' }];
    },
    async restart(name: string) { calls.push(`restart:${name}`); },
  };
}

const json = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function serve(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/api/host', router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    request: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/api/host${path}`, init),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('without the env var every route refuses and the socket is never opened', async () => {
  const calls: string[] = [];
  const server = await serve(createHostControlRouter({
    client: fakeClient(calls),
    store: fakeStore({ enabled: true, containers: true, restart: true }),
    env: {},
  }));
  try {
    const status = await server.request('/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      available: false,
      socketPath: '/var/run/docker.sock',
      reachable: false,
      enabled: true,
      capabilities: { facts: false, containers: true, restart: true },
    });
    assert.equal((await server.request('/containers')).status, 409);
    assert.equal((await server.request('/containers/gajae-app/restart', { method: 'POST' })).status, 409);
    assert.equal((await server.request('/settings', json({ enabled: false }))).status, 409);
    assert.deepEqual(calls, []);
  } finally {
    await server.close();
  }
});

test('every capability is its own switch, and listing does not imply restarting', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    assert.equal((await server.request('/containers')).status, 403);
    assert.equal((await server.request('/containers/gajae-app/restart', { method: 'POST' })).status, 403);

    const saved = await server.request('/settings', json({ containers: true }));
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { capabilities: unknown }).capabilities, {
      facts: false, containers: true, restart: false,
    });

    const list = await server.request('/containers');
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as { containers: Array<{ name: string }> }).containers.map((entry) => entry.name), ['gajae-app']);
    assert.equal((await server.request('/containers/gajae-app/restart', { method: 'POST' })).status, 403);
  } finally {
    await server.close();
  }
});

test('restart needs its switch and a plain container name', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true, containers: true });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    assert.equal((await server.request('/settings', json({ restart: true }))).status, 200);

    const invalid = await server.request('/containers/app%3Breboot/restart', { method: 'POST' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, 'INVALID_CONTAINER');

    const ok = await server.request('/containers/gajae-app/restart', { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { restarted: true, name: 'gajae-app' });
    assert.deepEqual(calls.filter((call) => call.startsWith('restart')), ['restart:gajae-app']);
  } finally {
    await server.close();
  }
});

test('the master switch drops every capability, so re-enabling cannot restore one', () => {
  const on = applyHostControlPatch(
    { enabled: true, facts: true, containers: true, restart: true },
    {},
  );
  assert.deepEqual(on, { enabled: true, facts: true, containers: true, restart: true });
  const off = applyHostControlPatch(on, { enabled: false });
  assert.deepEqual(off, { enabled: false, facts: false, containers: false, restart: false });
  assert.deepEqual(applyHostControlPatch(off, { enabled: true }), {
    enabled: true, facts: false, containers: false, restart: false,
  });
});

test('the docker client uses three fixed endpoints over a unix socket', async () => {
  const socketPath = join(tmpdir(), `gjc-docker-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === '/_ping') {
      response.end('OK');
      return;
    }
    if (request.url === '/containers/json?all=1') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([
        { Id: 'abcdef1234567890', Names: ['/gajae-app'], Image: 'ghcr.example/gajae', State: 'running', Status: 'Up 3 hours' },
        { Id: 'fedcba0987654321', Names: [], Image: 'orphan', State: 'exited', Status: 'Exited' },
      ]));
      return;
    }
    if (request.url === '/info') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ServerVersion: '29.9.3', OperatingSystem: 'Devuan GNU/Linux 6', KernelVersion: '6.18.22-mos',
        NCPU: 40, MemTotal: 134217728, Containers: 40, ContainersRunning: 38, ContainersStopped: 2, Images: 52,
      }));
      return;
    }
    if (request.url === '/containers/gajae-app/restart') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = dockerClient({ socketPath });
    assert.equal(await client.ping(), true);
    const containers = await client.list();
    assert.deepEqual(containers, [{
      id: 'abcdef123456', name: 'gajae-app', image: 'ghcr.example/gajae', state: 'running', status: 'Up 3 hours',
    }]);
    await client.restart('gajae-app');
    assert.deepEqual(seen, ['GET /_ping', 'GET /containers/json?all=1', 'POST /containers/gajae-app/restart']);    await assert.rejects(() => client.restart('app;reboot'), /is not a container name/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  }
});

test('a missing socket is reported, not thrown from the health check', async () => {
  const client = dockerClient({ socketPath: join(tmpdir(), `gjc-missing-${process.pid}.sock`), timeoutMs: 500 });
  assert.equal(await client.ping(), false);
  await assert.rejects(() => client.list(), /not reachable/u);
});

test('turning the master switch off is visible over HTTP and re-enabling grants nothing back', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true, facts: true, containers: true, restart: true });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    const off = await server.request('/settings', json({ enabled: false }));
    assert.equal(off.status, 200);
    assert.deepEqual((await off.json() as { capabilities: unknown }).capabilities, {
      facts: false, containers: false, restart: false,
    });
    assert.equal((await server.request('/containers')).status, 403);
    assert.equal((await server.request('/containers/gajae-app/restart', { method: 'POST' })).status, 403);

    const on = await server.request('/settings', json({ enabled: true }));
    assert.equal(on.status, 200);
    assert.deepEqual((await on.json() as { capabilities: unknown }).capabilities, {
      facts: false, containers: false, restart: false,
    });
    assert.equal((await server.request('/containers')).status, 403);
    assert.equal(calls.filter((call) => call.startsWith('restart')).length, 0);
  } finally {
    await server.close();
  }
});

test('daemon failures are 503 with their own code, never a 500', async () => {
  const failing = {
    async ping() { return true; },
    async info() { throw new DockerSocketError('DOCKER_TIMEOUT', 'The Docker daemon did not answer in time.'); },
    async list() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
    async restart() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
  };
  const server = await serve(createHostControlRouter({
    client: failing,
    store: fakeStore({ enabled: true, facts: true, containers: true, restart: true }),
    env: ENABLED_ENV,
  }));
  try {
    const info = await server.request('/info');
    assert.equal(info.status, 503);
    assert.equal((await info.json() as { error: string }).error, 'DOCKER_TIMEOUT');

    const list = await server.request('/containers');
    assert.equal(list.status, 503);
    assert.equal((await list.json() as { error: string }).error, 'DOCKER_HTTP');

    const restart = await server.request('/containers/missing/restart', { method: 'POST' });
    assert.equal(restart.status, 503);
    assert.equal((await restart.json() as { error: string }).error, 'DOCKER_HTTP');
  } finally {
    await server.close();
  }
});

test('a daemon that accepts the connection but never answers times out', async () => {
  const socketPath = join(tmpdir(), `gjc-stall-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const held: Array<import('node:net').Socket> = [];
  const server = createServer(() => { /* accept and stay silent */ });
  server.on('connection', (socket) => held.push(socket));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = dockerClient({ socketPath, timeoutMs: 200 });
    await assert.rejects(
      () => client.info(),
      (error: unknown) => error instanceof DockerSocketError && error.code === 'DOCKER_TIMEOUT',
    );
    assert.equal(await client.ping(), false);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  }
});

test('a restart gets a longer deadline than the read endpoints', async () => {
  const socketPath = join(tmpdir(), `gjc-restart-budget-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const server = createServer((request, response) => {
    if (request.url === '/containers/slow/restart') {
      setTimeout(() => { response.statusCode = 204; response.end(); }, 300);
      return;
    }
    // Every other endpoint is as slow as the restart, so only the long budget survives.
    setTimeout(() => { response.statusCode = 200; response.end('{}'); }, 300);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    // The read deadline is far too short for a 300ms restart; the restart budget covers it.
    const client = dockerClient({ socketPath, timeoutMs: 50, restartTimeoutMs: 2000 });
    await client.restart('slow');
    await assert.rejects(
      () => client.info(),
      (error: unknown) => error instanceof DockerSocketError && error.code === 'DOCKER_TIMEOUT',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  }
});

test('a container the daemon does not know is a 404, not a broken daemon', async () => {
  const socketPath = join(tmpdir(), `gjc-ghost-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end('{"message":"No such container: ghost"}');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = dockerClient({ socketPath });
    await assert.rejects(
      () => client.restart('ghost'),
      (error: unknown) => error instanceof DockerSocketError && error.code === 'DOCKER_NOT_FOUND',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  }

  const ghostClient: HostControlClient = {
    async ping() { return true; },
    async info() {
      return {
        serverVersion: 'dev', operatingSystem: 'Linux', kernelVersion: '6.18', ncpu: 1,
        memTotal: 1, containers: 0, containersRunning: 0, containersStopped: 0, images: 0,
      };
    },
    async list() { return []; },
    async restart() { throw new DockerSocketError('DOCKER_NOT_FOUND', 'There is no container called "ghost".'); },
  };
  const http = await serve(createHostControlRouter({
    client: ghostClient,
    store: fakeStore({ enabled: true, restart: true }),
    env: ENABLED_ENV,
  }));
  try {
    const restart = await http.request('/containers/ghost/restart', { method: 'POST' });
    assert.equal(restart.status, 404);
    assert.equal((await restart.json() as { error: string }).error, 'DOCKER_NOT_FOUND');
  } finally {
    await http.close();
  }
});

test('container names are the only thing that can reach the socket', () => {
  for (const name of ['gajae-app', 'app.1', 'a_b', 'A9']) assert.equal(isContainerName(name), true, name);
  for (const name of ['', '-app', 'app;reboot', 'app name', '$(id)', '../etc', 'a'.repeat(129), 'app/bar']) {
    assert.equal(isContainerName(name), false, name);
  }
});
