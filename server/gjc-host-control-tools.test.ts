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

/** The action names a tool offers, read off its discriminated-union schema. */
function actionNames(tool: { parameters?: unknown }): string[] {
  const options = (tool.parameters as { options?: Array<{ shape?: { action?: { value?: unknown } } }> } | undefined)?.options ?? [];
  return options.map((option) => String(option.shape?.action?.value));
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

const sshTarget = {
  host: '192.168.1.10',
  port: 22,
  user: 'root',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
};

function sshRun(commands: string[]) {
  return async (_target: unknown, command: string) => {
    commands.push(command);
    return { exitCode: 0, stdout: 'Linux webby 6.8.0', stderr: '', truncated: false, timedOut: false };
  };
}

test('an ssh read runs without asking, because the verb table is the whole surface', async () => {
  const commands: string[] = [];
  const tool = createHostControlTool(policy({ capabilities: ['hostRead'], ssh: sshTarget }), {
    run: sshRun(commands),
    ui: { select: async () => { assert.fail('a read verb must not ask for approval'); } },
  });

  const result = await run(tool, { action: 'ssh', verb: 'host.info' });
  assert.match(result, /Linux webby/);
  assert.match(result, /"mutating": false/);
  assert.deepEqual(commands, ['uname -a; cat /etc/os-release; uptime']);
});

test('an ssh write asks before it runs and a denial runs nothing', async () => {
  const commands: string[] = [];
  let asked: string | undefined;
  const tool = createHostControlTool(policy({ capabilities: ['hostWrite'], ssh: sshTarget }), {
    run: sshRun(commands),
    ui: { select: async (prompt) => { asked = prompt; return 'Deny'; } },
  });

  await assert.rejects(
    run(tool, { action: 'ssh', verb: 'docker.restart', target: 'godoxy' }),
    /was not approved/u,
  );
  assert.match(asked ?? '', /docker\.restart godoxy on root@192\.168\.1\.10/u);
  assert.deepEqual(commands, []);

  const approved = createHostControlTool(policy({ capabilities: ['hostWrite'], ssh: sshTarget }), {
    run: sshRun(commands),
    ui: { select: async () => 'Allow once' },
  });
  await run(approved, { action: 'ssh', verb: 'docker.restart', target: 'godoxy' });
  assert.deepEqual(commands, ['docker restart godoxy']);
});

test('prior authorization is the only way past the write question, and it needs the write switch', async () => {
  const commands: string[] = [];
  const tool = createHostControlTool(
    policy({ capabilities: ['hostWrite'], ssh: sshTarget, sshWritePreauthorized: true }),
    { run: sshRun(commands), ui: { select: async () => assert.fail('pre-authorized writes do not ask') } },
  );
  await run(tool, { action: 'ssh', verb: 'service.restart', target: 'nginx' });
  assert.deepEqual(commands, ['service nginx restart']);

  // The grant rides with the read switch only: a read-only run cannot be
  // talked into a mutating verb, whatever Settings says about pre-authorization.
  const readOnly = createHostControlTool(policy({ capabilities: ['hostRead'], ssh: sshTarget }), { run: sshRun(commands) });
  await assert.rejects(
    run(readOnly, { action: 'ssh', verb: 'service.restart', target: 'nginx' }),
    /hostWrite capability is off/u,
  );
  assert.deepEqual(commands, ['service nginx restart']);
});

test('a shell command is a host write: the card shows it verbatim and a denial runs nothing', async () => {
  const commands: string[] = [];
  let asked = '';
  const tool = createHostControlTool(policy({ capabilities: ['hostWrite'], ssh: sshTarget }), {
    run: sshRun(commands),
    ui: { select: async (prompt) => { asked = prompt; return 'Deny'; } },
  });

  const script = 'cat >/srv/app/.env <<\'EOF\'\nDEBUG=true\nEOF';
  await assert.rejects(run(tool, { action: 'host_shell', command: script }), /was not approved/u);
  assert.ok(asked.includes(script), 'the approval must show the command, not a summary of it');
  assert.deepEqual(commands, []);

  const approved = createHostControlTool(policy({ capabilities: ['hostWrite'], ssh: sshTarget }), {
    run: sshRun(commands),
    ui: { select: async () => 'Allow once' },
  });
  await run(approved, { action: 'host_shell', command: 'systemctl restart nginx' });
  assert.deepEqual(commands, ['systemctl restart nginx']);
});

test('pre-authorized host writes skip the shell question too', async () => {
  const commands: string[] = [];
  const tool = createHostControlTool(
    policy({ capabilities: ['hostWrite'], ssh: sshTarget, sshWritePreauthorized: true }),
    { run: sshRun(commands), ui: { select: async () => assert.fail('pre-authorized commands do not ask') } },
  );
  await run(tool, { action: 'host_shell', command: 'docker compose up -d' });
  assert.deepEqual(commands, ['docker compose up -d']);
});

test('host_shell needs the write switch', async () => {
  const commands: string[] = [];
  const readOnly = createHostControlTool(policy({ capabilities: ['hostRead'], ssh: sshTarget }), { run: sshRun(commands) });
  await assert.rejects(
    run(readOnly, { action: 'host_shell', command: 'uptime' }),
    /hostWrite capability is off/u,
  );
  assert.deepEqual(commands, []);
});

test('a deployment without SSH is not offered the SSH actions at all', () => {
  const tool = createHostControlTool(policy({ capabilities: ['facts', 'hostRead', 'hostWrite'] }), {});
  // The schema is the surface the model sees: no ssh, no host_shell.
  assert.deepEqual(actionNames(tool), ['info', 'containers', 'discovery', 'restart', 'container_action', 'exec', 'read_file']);
  assert.equal(tool.description.includes('host_shell'), false);
  assert.equal(tool.description.includes('ssh'), false);
});
