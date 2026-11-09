import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteComputerHub } from './remote-computer-hub.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

/**
 * A hub with one dispatchable device and a recording socket standing in for a
 * live companion connection. This is the seam the companion's own logs exposed:
 * every remote call reached agent-desktop as `{"arguments": {...}}`, because the
 * hub forwarded the `{ tool, arguments }` guard envelope instead of the argument
 * record, and nothing in the suite looked at what actually went over the wire.
 */
function connected() {
  const devices = new RemoteComputerDeviceRegistry(memoryStorage());
  const registered = devices.registerUnattended('laptop', 'macos x86_64');
  devices.update(registered.device.id, { enabled: true });
  const hub = new RemoteComputerHub(devices);
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: 1, OPEN: 1, close() {},
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>); },
  };
  const internals = hub as unknown as { connections: Map<string, { socket: unknown; pending: Map<string, unknown>; seen: Set<string> }> };
  internals.connections.set(registered.device.id, { socket, pending: new Map(), seen: new Set() });
  return { hub, deviceId: registered.device.id, sent };
}

test('a remote call carries the argument record, never the guard envelope', async () => {
  const { hub, deviceId, sent } = connected();
  const pending = hub.call(deviceId, 'session', 'desktop_launch', { app: 'Safari', activate: true });
  pending.catch(() => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'computer.request');
  assert.equal(sent[0]?.tool, 'desktop_launch');
  assert.deepEqual(sent[0]?.arguments, { app: 'Safari', activate: true });

  const requestId = String(sent[0]?.requestId);
  const internals = hub as unknown as { connections: Map<string, { pending: Map<string, { resolve: (value: unknown) => void }> }> };
  internals.connections.get(deviceId)?.pending.get(requestId)?.resolve({ ok: true });
  await pending;
});

test('a tool that accepts no arguments sends an empty record, not itself', async () => {
  const { hub, deviceId, sent } = connected();
  const pending = hub.call(deviceId, 'session', 'desktop_status', {});
  pending.catch(() => {});

  assert.deepEqual(sent[0]?.arguments, {});

  const requestId = String(sent[0]?.requestId);
  const internals = hub as unknown as { connections: Map<string, { pending: Map<string, { resolve: (value: unknown) => void }> }> };
  internals.connections.get(deviceId)?.pending.get(requestId)?.resolve({});
  await pending;
});

test('a policy-denied call never reaches the companion', async () => {
  const { hub, deviceId, sent } = connected();
  await assert.rejects(hub.call(deviceId, 'session', 'desktop_launch', { app_name: 'Safari' }), /does not document an argument named "app_name"/u);
  assert.deepEqual(sent, []);
});
