import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  dockerClient,
  DockerSocketError,
  isContainerName,
  listTarEntries,
  parseExecFrames,
  type HostControlClient,
} from '../../gjc-engine.js';

import { createHostControlRouter, type HostControlStore, type HostProfileStore } from './host-control.routes.js';
import type { SavedHostProfile } from './host-profile.store.js';
import {
  applyHostControlPatch,
  DEFAULT_HOST_CONTROL_SETTINGS,
  matchesHostTarget,
  type HostCapability,
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

/** Detection is remembered in the database; tests keep it in a variable instead. */
function fakeProfiles(): HostProfileStore {
  let saved: SavedHostProfile | null = null;
  return {
    read: () => saved,
    write: (profile) => (saved = { detectedAt: 1, profile }),
  };
}

/** Every capability, all off: assertions add the ones a test switches on. */
function capabilities(overrides: Partial<Record<HostCapability, boolean>> = {}) {
  return {
    facts: false, containers: false, restart: false, discovery: false, docker: false, shell: false, files: false,
    hostRead: false, hostWrite: false, ...overrides,
  };
}

/** The connection half of the settings, which the master switch leaves alone. */
const SSH_DEFAULTS = { sshHost: '', sshPort: 22, sshUser: 'root', sshHostKey: '', sshWritePreauthorized: false };

function fakeClient(calls: string[]) {
  return {
    async ping() { calls.push('ping'); return true; },
    async info() {
      calls.push('info');
      return {
        serverVersion: '29.9.3', operatingSystem: 'Linux', kernelVersion: '6.18.22',
        hostName: 'nas', driver: 'overlay2', swarm: 'inactive',
        ncpu: 4, memTotal: 1024, containers: 2, containersRunning: 1, containersStopped: 1, images: 3,
      };
    },
    async list() {
      calls.push('list');
      return [{
        id: 'abcdef123456', name: 'gajae-app', image: 'ghcr.example/gajae', state: 'running', status: 'Up 3 hours',
        labels: {}, mounts: [],
      }];
    },
    async restart(name: string) { calls.push(`restart:${name}`); },
    async action(name: string, action: string) { calls.push(`action:${name}:${action}`); },
    async exec(name: string, command: readonly string[]) {
      calls.push(`exec:${name}:${command.join(' ')}`);
      return { exitCode: 0, stdout: 'NAME=Nas\n', stderr: '', truncated: false };
    },
    async archive(name: string, path: string) {
      calls.push(`archive:${name}:${path}`);
      return { kind: 'file' as const, name: 'hostname', size: 4, content: Buffer.from('nas\n'), truncated: false };
    },
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

test('without the env var the surface is inert and the socket is never opened', async () => {
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
      capabilities: capabilities({ containers: true, restart: true }),
      targets: [],
      // The endpoint is described, never the key: only whether one is stored.
      ssh: { host: '', port: 22, user: 'root', hostKey: '', keyPresent: false, writePreauthorized: false },
      host: null,
    });
    assert.equal((await server.request('/settings', json({ enabled: false }))).status, 409);
    assert.equal((await server.request('/discovery')).status, 409);
    assert.deepEqual(calls, []);
  } finally {
    await server.close();
  }
});

test('the removed container endpoints are not served at all', async () => {
  const calls: string[] = [];
  const server = await serve(createHostControlRouter({
    client: fakeClient(calls),
    store: fakeStore({ enabled: true, facts: true, containers: true, restart: true, docker: true, shell: true, files: true, targets: ['*'] }),
    env: ENABLED_ENV,
  }));
  const post = (body?: unknown) => ({
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    for (const path of ['/info', '/containers', '/verbs', '/files?container=x&path=/etc/hostname', '/exec']) {
      assert.equal((await server.request(path, post(path === '/exec' ? { container: 'x', verb: 'os' } : undefined))).status, 404, path);
    }
    for (const path of ['/containers/x/restart', '/containers/x/action']) {
      assert.equal((await server.request(path, post({ action: 'stop' }))).status, 404, path);
    }
    assert.deepEqual(calls, [], 'no removed endpoint reaches the daemon');
  } finally {
    await server.close();
  }
});

test('the master switch drops every capability and the target scope, so re-enabling restores nothing', () => {
  const allOn = capabilities({ facts: true, containers: true, restart: true, discovery: true, docker: true, shell: true, files: true, hostRead: true, hostWrite: true });
  const on = applyHostControlPatch({ enabled: true, ...SSH_DEFAULTS, ...allOn, targets: ['mos-*'] }, {});
  assert.deepEqual(on, { enabled: true, ...SSH_DEFAULTS, ...allOn, targets: ['mos-*'] });
  const off = applyHostControlPatch(on, { enabled: false });
  // The address and the pinned host key are settings, not permissions, so they
  // survive: turning the feature back on must not ask for the key again.
  assert.deepEqual(off, { enabled: false, ...SSH_DEFAULTS, ...capabilities(), targets: [] });
  assert.deepEqual(applyHostControlPatch(off, { enabled: true }), {
    enabled: true, ...SSH_DEFAULTS, ...capabilities(), targets: [],
  });
});

test('turning the master switch off is visible over HTTP and re-enabling grants nothing back', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true, facts: true, containers: true, restart: true, discovery: true });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    const off = await server.request('/settings', json({ enabled: false }));
    assert.equal(off.status, 200);
    assert.deepEqual((await off.json() as { capabilities: unknown }).capabilities, capabilities());
    assert.equal((await server.request('/discovery')).status, 403);

    const on = await server.request('/settings', json({ enabled: true }));
    assert.equal(on.status, 200);
    assert.deepEqual((await on.json() as { capabilities: unknown }).capabilities, capabilities());
    assert.equal((await server.request('/discovery')).status, 403);
    assert.equal(calls.filter((call) => call !== 'ping').length, 0);
  } finally {
    await server.close();
  }
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
      labels: {}, mounts: [],
    }]);
    await client.restart('gajae-app');
    assert.deepEqual(seen, ['GET /_ping', 'GET /containers/json?all=1', 'POST /containers/gajae-app/restart']);
    await assert.rejects(() => client.restart('app;reboot'), /is not a container name/u);
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

test('a daemon failure on discovery is a 503 with its own code, never a 500', async () => {
  const failing = {
    async ping() { return true; },
    async info() { throw new DockerSocketError('DOCKER_TIMEOUT', 'The Docker daemon did not answer in time.'); },
    async list() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
    async restart() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
    async action() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
    async exec() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
    async archive() { throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon answered 404.'); },
  };
  const server = await serve(createHostControlRouter({
    client: failing,
    store: fakeStore({ enabled: true, discovery: true }),
    env: ENABLED_ENV,
  }));
  try {
    const discovery = await server.request('/discovery');
    assert.equal(discovery.status, 503);
    assert.equal((await discovery.json() as { error: string }).error, 'DOCKER_TIMEOUT');
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
});

test('a 404 for something other than a container is a daemon fault, not a missing container', async () => {
  const socketPath = join(tmpdir(), `gjc-page404-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const server = createServer((request, response) => {
    response.statusCode = 404;
    if (request.url === '/containers/blank/restart') {
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end('{"message":"page not found"}');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = dockerClient({ socketPath });
    await assert.rejects(
      () => client.restart('ghost'),
      (error: unknown) => error instanceof DockerSocketError && error.code === 'DOCKER_HTTP',
    );
    // A bare 404 carries no message to contradict the missing-container reading.
    await assert.rejects(
      () => client.restart('blank'),
      (error: unknown) => error instanceof DockerSocketError && error.code === 'DOCKER_NOT_FOUND',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  }
});

test('container names are the only thing that can reach the socket', () => {
  // `bad..name` is a name the daemon accepts and simply does not have, so it is
  // a 404 later, not a 400 here.
  for (const name of ['gajae-app', 'app.1', 'a_b', 'A9', 'bad..name']) assert.equal(isContainerName(name), true, name);
  for (const name of ['', '-app', 'app;reboot', 'app name', '$(id)', '../etc', 'a'.repeat(129), 'app/bar']) {
    assert.equal(isContainerName(name), false, name);
  }
});

/** A minimal tar so the archive reader can be tested without a daemon. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  return header;
}

function tarFile(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length), data, padding, Buffer.alloc(1024)]);
}

function execFrame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text);
  const frame = Buffer.alloc(8 + data.length);
  frame[0] = stream;
  frame.writeUInt32BE(data.length, 4);
  data.copy(frame, 8);
  return frame;
}

test('the archive reader finds the file in the tar the daemon sends', () => {
  const entries = listTarEntries(tarFile('hostname', 'nas\n'));
  assert.deepEqual(entries.map((entry) => ({ name: entry.name, size: entry.size, type: entry.type })), [
    { name: 'hostname', size: 4, type: 'file' },
  ]);
  assert.equal(tarFile('hostname', 'nas\n').subarray(entries[0]!.dataStart, entries[0]!.dataStart + 4).toString('utf8'), 'nas\n');
});

test('exec output is read as a multiplexed stream, and a plain body still reads', () => {
  assert.deepEqual(parseExecFrames(Buffer.concat([execFrame(1, 'out\n'), execFrame(2, 'err\n')])), {
    stdout: 'out\n', stderr: 'err\n',
  });
  // A proxy that answers without frames must not lose the output.
  assert.deepEqual(parseExecFrames(Buffer.from('plain text')), { stdout: 'plain text', stderr: '' });
});

test('the allowed-containers list is a glob, not a substring', () => {
  assert.equal(matchesHostTarget(['mos-*'], 'mos-web'), true);
  assert.equal(matchesHostTarget(['mos-*'], 'xmos-web'), false);
  assert.equal(matchesHostTarget(['immich_?'], 'immich_a'), true);
  assert.equal(matchesHostTarget(['immich_?'], 'immich_ab'), false);
  assert.equal(matchesHostTarget(['GAJAE-app'], 'gajae-app'), true);
  assert.equal(matchesHostTarget([], 'anything'), false);
});

test('allowed containers are validated, deduplicated, and dropped with the master switch', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    const invalid = await server.request('/settings', json({ targets: ['mos-*', 'bad/name'] }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, 'HOST_SETTINGS_INVALID');

    const saved = await server.request('/settings', json({ targets: ['mos-*', ' mos-* ', 'immich_?'] }));
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { targets: string[] }).targets, ['mos-*', 'immich_?']);

    const off = await server.request('/settings', json({ enabled: false }));
    assert.deepEqual((await off.json() as { targets: string[] }).targets, []);
  } finally {
    await server.close();
  }
});

test('discovery names the manager it can see and who else holds the socket', async () => {
  const calls: string[] = [];
  const client: HostControlClient = {
    ...fakeClient(calls),
    async info() {
      return {
        serverVersion: '29.9.3', operatingSystem: 'Linux', kernelVersion: '6.12.10-Unraid',
        hostName: 'tower', driver: 'overlay2', swarm: 'inactive',
        ncpu: 8, memTotal: 2048, containers: 4, containersRunning: 3, containersStopped: 1, images: 9,
      };
    },
    async list() {
      const container = (name: string, image: string, labels: Record<string, string>, mounts: Array<{ type: string; source: string; destination: string }>) => ({
        id: name.padEnd(12, '0'), name, image, state: 'running', status: 'Up 2 days', labels, mounts,
      });
      return [
        container('portainer', 'portainer/portainer-ce:2.21', {}, [{ type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' }]),
        container('mos-web', 'ghcr.example/mos-web:1', { 'com.docker.compose.project': 'mos', 'com.docker.compose.service': 'web' }, []),
        container('mos-db', 'postgres:17', { 'com.docker.compose.project': 'mos', 'com.docker.compose.service': 'db' }, []),
        container('adhoc', 'alpine', {}, []),
      ];
    },
  };
  const server = await serve(createHostControlRouter({
    client, store: fakeStore({ enabled: true, discovery: true }), profiles: fakeProfiles(), env: ENABLED_ENV,
  }));
  try {
    const response = await server.request('/discovery');
    assert.equal(response.status, 200);
    const { profile } = await response.json() as { profile: {
      platforms: Array<{ id: string }>; managers: Array<{ id: string }>; socketHolders: string[]; stacks: unknown[]; unmanaged: string[]; guidance: string[];
    } };
    // Unraid is seen through its kernel and Mos through its containers; those
    // are the machine's own layer. Portainer is a manager running on it.
    assert.deepEqual(profile.platforms.map((platform) => platform.id).sort(), ['mos', 'unraid']);
    assert.deepEqual(profile.managers.map((manager) => manager.id), ['portainer']);
    assert.deepEqual(profile.socketHolders, ['portainer']);
    assert.deepEqual(profile.stacks, [{ project: 'mos', services: ['web', 'db'], containers: ['mos-web', 'mos-db'] }]);
    assert.deepEqual(profile.unmanaged, ['portainer', 'adhoc']);
    assert.ok(profile.guidance.some((line) => line.includes('Unraid is this machine')));

    // The detection is stored, and the cheap status read reports it, so a
    // caller that never ran the detection still learns the machine's OS - and
    // that it is an appliance, not just "Linux".
    const snapshot = await (await server.request('/status')).json() as {
      host: { os: string; kernelVersion: string; platform: { id: string; label: string } | null; detectedAt: number } | null;
    };
    assert.deepEqual(snapshot.host, {
      os: 'Linux', kernelVersion: '6.12.10-Unraid', platform: { id: 'unraid', label: 'Unraid' }, detectedAt: 1,
    });
  } finally {
    await server.close();
  }
});

test('switching the host reads on detects once; no save or session start detects again', async () => {
  const calls: string[] = [];
  const profiles = fakeProfiles();
  const server = await serve(createHostControlRouter({
    client: fakeClient(calls), store: fakeStore({ enabled: true }), profiles, env: ENABLED_ENV,
  }));
  try {
    // The master switch alone grants nothing: discovery is still off, so no read.
    await server.request('/settings', json({ enabled: true }));
    assert.deepEqual(calls.filter((call) => call !== 'ping'), [], 'no daemon read until the read switch is on');

    // Turning the read switch on answers the question in the same response.
    const response = await server.request('/settings', json({ facts: true, discovery: true }));
    assert.equal(response.status, 200);
    const snapshot = await response.json() as { host: { os: string; platform: unknown } | null };
    assert.equal(snapshot.host?.os, 'Linux');
    assert.equal(snapshot.host?.platform, null);
    assert.deepEqual(calls.filter((call) => call === 'info' || call === 'list'), ['info', 'list']);

    // Saving anything else reuses the stored picture instead of re-reading.
    await server.request('/settings', json({ targets: ['gajae-*'] }));
    assert.deepEqual(calls.filter((call) => call === 'info' || call === 'list'), ['info', 'list']);

    // Status never runs a detection either: it reports what was stored.
    await server.request('/status');
    assert.deepEqual(calls.filter((call) => call === 'info' || call === 'list'), ['info', 'list']);
    assert.equal(profiles.read()?.profile.runtime.hostName, 'nas');
  } finally {
    await server.close();
  }
});

test('a daemon that cannot be reached does not fail the save that switched reads on', async () => {
  const calls: string[] = [];
  const broken: HostControlClient = {
    ...fakeClient(calls),
    async info() { calls.push('info'); throw new DockerSocketError('DOCKER_UNAVAILABLE', 'gone'); },
  };
  const server = await serve(createHostControlRouter({
    client: broken, store: fakeStore({ enabled: true }), profiles: fakeProfiles(), env: ENABLED_ENV,
  }));
  try {
    const response = await server.request('/settings', json({ facts: true, discovery: true }));
    assert.equal(response.status, 200);
    const snapshot = await response.json() as { capabilities: { discovery: boolean }; host: unknown };
    assert.equal(snapshot.capabilities.discovery, true, 'the switch the operator flipped is saved');
    assert.equal(snapshot.host, null, 'and no half-built picture is reported');
  } finally {
    await server.close();
  }
});

test('a profile saved before platforms existed still answers status', async () => {
  const calls: string[] = [];
  // An older detection stored the runtime and nothing else; the stored record
  // predates `platforms`, so status must not read through it.
  const legacy = {
    detectedAt: 5,
    profile: {
      runtime: {
        serverVersion: '29.9.3', operatingSystem: 'Devuan GNU/Linux 6', kernelVersion: '6.18.60-mos',
        driver: 'overlay2', swarm: 'inactive', hostName: 'Webby',
      },
      platforms: undefined,
    },
  } as unknown as SavedHostProfile;
  const server = await serve(createHostControlRouter({
    client: fakeClient(calls),
    store: fakeStore({ enabled: true, discovery: true }),
    profiles: { read: () => legacy, write: () => legacy },
    env: ENABLED_ENV,
  }));
  try {
    const response = await server.request('/status');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { host: unknown }).host, {
      os: 'Devuan GNU/Linux 6', kernelVersion: '6.18.60-mos', platform: null, detectedAt: 5,
    });
  } finally {
    await server.close();
  }
});

test('discovery is its own switch and reports nothing about the host while off', async () => {
  const calls: string[] = [];
  const store = fakeStore({ enabled: true, containers: true, targets: ['mos-*'] });
  const server = await serve(createHostControlRouter({ client: fakeClient(calls), store, env: ENABLED_ENV }));
  try {
    assert.equal((await server.request('/discovery')).status, 403);
    assert.equal(((await (await server.request('/status')).json()) as { host: unknown }).host, null);
    assert.deepEqual(calls.filter((call) => call !== 'ping'), [], 'nothing reaches the socket without its switch');
  } finally {
    await server.close();
  }
});
