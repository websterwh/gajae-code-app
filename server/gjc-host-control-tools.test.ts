import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostControlTool } from './gjc-host-control-tools.js';
import type { HostControlClient } from './gjc-docker-socket.js';
import type { HostControlRunPolicy } from './gjc-host-control-policy.js';

type Callable = {
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: Array<{ text: string }> }>;
};

function run(tool: unknown, params: unknown): Promise<string> {
  return (tool as Callable).execute('call-1', params, undefined).then((result) => {
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.text.length > 0, true);
    return result.content[0]!.text;
  });
}

function fakeClient(): { client: HostControlClient; calls: string[] } {
  const calls: string[] = [];
  const client: HostControlClient = {
    async ping() { return true; },
    async info() {
      calls.push('info');
      return {
        serverVersion: '27.0.3',
        operatingSystem: 'Debian GNU/Linux 12',
        kernelVersion: '6.8.0',
        hostName: 'webby',
        driver: 'overlay2',
        swarm: 'inactive',
        ncpu: 4,
        memTotal: 8_000_000,
        containers: 3,
        containersRunning: 2,
        containersStopped: 1,
        images: 5,
      };
    },
    async list() {
      calls.push('list');
      return [{
        id: 'abc123def456',
        name: 'godoxy',
        image: 'ghcr.io/yusing/godoxy:latest',
        state: 'running',
        status: 'Up 3 days',
        labels: { 'com.docker.compose.project': 'godoxy', 'com.docker.compose.service': 'godoxy' },
        mounts: [{ type: 'bind', source: '/opt/godoxy', destination: '/app' }],
      }];
    },
    async restart(name) { calls.push(`restart:${name}`); },
    async action(name, action) { calls.push(`action:${name}:${action}`); },
    async exec(name, command) {
      calls.push(`exec:${name}:${command.join(' ')}`);
      return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false };
    },
    async archive(name, path) {
      calls.push(`archive:${name}:${path}`);
      if (path.endsWith('config.yml')) {
        return { kind: 'file', name: 'config.yml', size: 5, content: Buffer.from('hello'), truncated: false };
      }
      return { kind: 'dir', entries: [{ name: 'config.yml', size: 5, type: 'file' }], truncated: false };
    },
  };
  return { client, calls };
}

function policy(overrides: Partial<HostControlRunPolicy> = {}): HostControlRunPolicy {
  return {
    socketPath: '/var/run/docker.sock',
    capabilities: ['facts', 'containers', 'discovery', 'docker', 'shell', 'files', 'restart'],
    targets: ['godoxy', 'immich_*'],
    ...overrides,
  };
}

test('host reads the daemon directly instead of the app HTTP routes', async () => {
  const { client, calls } = fakeClient();
  const tool = createHostControlTool(policy(), { client });

  const info = await run(tool, { action: 'info' });
  assert.match(info, /Debian GNU\/Linux 12/);
  const containers = await run(tool, { action: 'containers' });
  assert.match(containers, /godoxy/);
  assert.match(containers, /com\.docker\.compose\.project/);
  const discovery = await run(tool, { action: 'discovery' });
  assert.match(discovery, /godoxy/);

  assert.deepEqual(calls, ['info', 'list', 'info', 'list']);
});

test('a capability that is switched off is refused before the socket is touched', async () => {
  const { client, calls } = fakeClient();
  const tool = createHostControlTool(policy({ capabilities: ['facts'] }), { client });

  await assert.rejects(run(tool, { action: 'containers' }), /host containers capability is off/u);
  await assert.rejects(
    run(tool, { action: 'exec', container: 'godoxy', verb: 'network' }),
    /host shell capability is off/u,
  );
  assert.deepEqual(calls, []);
});

test('reaching capabilities stay inside the allowed-container globs', async () => {
  const { client, calls } = fakeClient();
  const tool = createHostControlTool(policy(), { client });

  await assert.rejects(
    run(tool, { action: 'exec', container: 'caddy', verb: 'network' }),
    /not on the host-control Allowed containers list/u,
  );
  await assert.rejects(
    run(tool, { action: 'container_action', container: 'caddy', operation: 'stop' }),
    /Allowed containers list/u,
  );
  const exec = await run(tool, { action: 'exec', container: 'godoxy', verb: 'network' });
  assert.match(exec, /"stdout": "ok"/);
  // A glob is enough for a family of names the operator wrote down.
  await run(tool, { action: 'container_action', container: 'immich_server', operation: 'restart' });

  assert.deepEqual(calls, [
    'exec:godoxy:ip addr',
    'action:immich_server:restart',
  ]);
});

test('exec accepts only documented verbs, and read_file only absolute paths', async () => {
  const { client, calls } = fakeClient();
  const tool = createHostControlTool(policy(), { client });

  await assert.rejects(
    run(tool, { action: 'exec', container: 'godoxy', verb: 'rm -rf' }),
    /Known verbs: os, uptime, memory, processes, disk, root, network/u,
  );
  await assert.rejects(
    run(tool, { action: 'read_file', container: 'godoxy', path: '/app/../../etc/shadow' }),
    /absolute path with no "\.\." segment/u,
  );
  const file = await run(tool, { action: 'read_file', container: 'godoxy', path: '/app/config.yml' });
  assert.match(file, /"content": "hello"/);
  const directory = await run(tool, { action: 'read_file', container: 'godoxy', path: '/app' });
  assert.match(directory, /"entries"/);
  assert.deepEqual(calls, ['archive:godoxy:/app/config.yml', 'archive:godoxy:/app']);
});

test('restart is one named container with its own switch, not the allowed list', async () => {
  const { client, calls } = fakeClient();
  const restartOnly = createHostControlTool(policy({ capabilities: ['restart'], targets: [] }), { client });

  const result = await run(restartOnly, { action: 'restart', container: 'anything' });
  assert.match(result, /"restarted": true/);
  assert.deepEqual(calls, ['restart:anything']);

  const readOnly = createHostControlTool(policy({ capabilities: ['facts'] }), { client });
  await assert.rejects(
    run(readOnly, { action: 'restart', container: 'anything' }),
    /restart capability is off/u,
  );
  assert.equal(calls.length, 1);
});
