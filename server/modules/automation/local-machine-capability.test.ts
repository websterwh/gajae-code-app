import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteCuaReadiness } from '../../../shared/remote-cua-protocol.js';

import { AutomationGrantStore } from './automation-grants.js';
import { AutomationService } from './automation.service.js';
import { ComputerUseStore } from './computer-use.js';
import { guardLocalMachineCall } from './local-machine-capability.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

function readiness(safeTools: string[]): RemoteCuaReadiness {
  return { schemaSupported: true, daemon: 'running', safeTools, deviceName: 'laptop', os: 'linux x86_64' };
}

/**
 * A service whose selected device is a real registry record and whose hub is a
 * recorder: everything above the transport (companion opt-in check, policy
 * validation) is the real implementation.
 */
function service(options: { paired: boolean; safeTools: string[] }) {
  const instance = new AutomationService();
  const computerUse = new ComputerUseStore(memoryStorage());
  computerUse.set(true);
  Object.defineProperty(instance, 'computerUse', { value: computerUse });
  Object.defineProperty(instance, 'grants', { value: new AutomationGrantStore(memoryStorage()) });

  const devices = new RemoteComputerDeviceRegistry(memoryStorage());
  if (options.paired) {
    const registered = devices.registerUnattended('laptop', 'linux x86_64');
    devices.update(registered.device.id, { enabled: true, readiness: readiness(options.safeTools) });
    devices.select(registered.device.id);
  }
  Object.defineProperty(instance, 'remoteDevices', { value: devices });

  const dispatched: Array<{ deviceId: string; tool: string; args: Record<string, unknown> }> = [];
  Object.defineProperty(instance, 'remoteComputerHub', {
    value: {
      call: async (deviceId: string, _sessionId: string, tool: string, args: Record<string, unknown>) => {
        dispatched.push({ deviceId, tool, args });
        return { stdout: 'ok', exit_code: 0 };
      },
    },
  });
  return { instance, dispatched, devices };
}

test('local tools reject undocumented arguments and out-of-range payloads', () => {
  assert.throws(
    () => guardLocalMachineCall('local_exec', {}),
    { name: 'LocalMachinePolicyError', message: /requires "command"/u },
  );
  assert.throws(
    () => guardLocalMachineCall('local_exec', { command: 'ls', shell: 'zsh' }),
    { name: 'LocalMachinePolicyError', message: /does not document an argument named "shell"/u },
  );
  assert.throws(
    () => guardLocalMachineCall('local_write_file', { path: '/tmp/a', content: 'x'.repeat(1024 * 1024 + 1) }),
    /exceeds 1048576 UTF-8 bytes/u,
  );
  assert.throws(
    () => guardLocalMachineCall('local_search', { path: '/tmp', pattern: 'needle', max_results: 5_000 }),
    /must be between 1 and 1000/u,
  );
  assert.throws(
    () => guardLocalMachineCall('local_read_file', { path: '/tmp/a', limit: 0 }),
    /must be between 1 and 5000/u,
  );
  assert.deepEqual(
    guardLocalMachineCall('local_exec', { command: 'ls -la', cwd: '/tmp', timeout_ms: 5_000 }).arguments,
    { command: 'ls -la', cwd: '/tmp', timeout_ms: 5_000 },
  );
});

test('local tools need a paired companion because they run on the user machine', async () => {
  const { instance, dispatched } = service({ paired: false, safeTools: [] });
  await assert.rejects(
    instance.callComputer('session-a', 'local_exec', { command: 'ls' }),
    /needs a paired companion/u,
  );
  assert.equal(dispatched.length, 0, 'nothing may be dispatched without a paired device');
});

test('local tools are refused unless the companion was started with --shell', async () => {
  const { instance, dispatched } = service({ paired: true, safeTools: ['desktop_list_apps'] });
  await assert.rejects(
    instance.callComputer('session-a', 'local_exec', { command: 'ls' }),
    /--shell/u,
  );
  assert.equal(dispatched.length, 0);
});

test('an opted-in companion receives the validated local call', async () => {
  const { instance, dispatched } = service({ paired: true, safeTools: ['local_exec', 'local_search'] });
  const result = await instance.callComputer('session-a', 'local_exec', {
    command: 'git status --short',
    cwd: '/home/person/repo',
    shell: 'ignored-by-test',
  }).catch((error: unknown) => error);
  assert.match(String(result), /does not document an argument named "shell"/u);
  assert.equal(dispatched.length, 0, 'a malformed call must not reach the companion');

  const accepted = await instance.callComputer('session-a', 'local_search', { path: '/home/person/repo', pattern: 'TODO' });
  assert.deepEqual(accepted, { stdout: 'ok', exit_code: 0 });
  assert.equal(dispatched.length, 1);
  const [first] = dispatched;
  assert.deepEqual(first?.args, { path: '/home/person/repo', pattern: 'TODO' });
});

test('local tools stay unavailable when computer use is off', async () => {
  const { instance } = service({ paired: true, safeTools: ['local_exec'] });
  Object.defineProperty(instance, 'computerUse', { value: (() => {
    const store = new ComputerUseStore(memoryStorage());
    store.set(false);
    return store;
  })() });
  await assert.rejects(
    instance.callComputer('session-a', 'local_exec', { command: 'ls' }),
    /Computer use is off/u,
  );
});
