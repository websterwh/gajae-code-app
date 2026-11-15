import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import {
  AutomationService, configureDesktopRestartAdmission, createAutomationDesktopRestartReader,
  createBrowserDesktopRestartReader, createComputerDesktopRestartReader,
} from './automation.service.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

const READINESS = {
  schemaSupported: true,
  daemon: 'running' as const,
  safeTools: ['desktop_list_apps', 'local_exec'],
  deviceName: 'test-host',
  os: 'linux x86_64',
};

function withComputer(service: AutomationService, call: (signal?: AbortSignal) => Promise<unknown> = async () => ({ ok: true })) {
  const values = new Map<string, string>();
  const devices = new RemoteComputerDeviceRegistry({
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
  });
  const registered = devices.registerUnattended('test-host', 'linux x86_64');
  devices.update(registered.device.id, { enabled: true, readiness: READINESS });
  devices.select(registered.device.id);
  Object.defineProperty(service, 'remoteDevices', { value: devices });
  Object.defineProperty(service, 'remoteComputerHub', {
    value: {
      call: (_deviceId: string, _sessionId: string, _tool: string, _args: Record<string, unknown>, signal?: AbortSignal) =>
        call(signal),
      readiness: () => READINESS,
      isConnected: () => true,
    },
  });
  return service;
}

class Admission implements DesktopWorkAdmission {
  fenced = false;
  active = 0;
  sources: string[] = [];
  enter(source: string): () => void {
    this.sources.push(source);
    if (this.fenced) throw new Error('restart fenced');
    this.active++;
    let released = false;
    return () => {
      assert.equal(released, false, 'admission must release exactly once');
      released = true;
      this.active--;
    };
  }
  enterCompletion(): () => void { throw new Error('new automation must not claim completion admission'); }
}

function environment(t: TestContext, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = value; });
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('expected asynchronous transition did not happen');
}

function idle(activity: DesktopOwnerActivity): void {
  assert.equal(activity.complete, true);
  assert.deepEqual(activity.unknown, []);
  for (const field of ['starting', 'queued', 'running', 'settling', 'retained', 'approvals'] as const) {
    assert.equal(activity[field], 0, `${activity.owner}.${field}`);
  }
}

test('all three readers are pure, complete for healthy unused owners, and independent snapshots', async (t) => {
  const admission = new Admission();
  const service = withComputer(new AutomationService());
  configureDesktopRestartAdmission(admission, service);
  const readers = [createAutomationDesktopRestartReader(service), createBrowserDesktopRestartReader(service.browser), createComputerDesktopRestartReader(service)];
  for (const reader of readers) {
    const generation = reader.getGeneration();
    const snapshot = await reader.read();
    idle(snapshot);
    assert.equal(snapshot.generation, generation);
    (snapshot.unknown as string[]).push('caller_mutation');
    idle(await reader.read());
    assert.equal(reader.getGeneration(), generation);
  }
  assert.deepEqual(admission.sources, []);
});

test('fenced direct service producers reject before startup or dispatch', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1' });
  const admission = new Admission();
  const service = withComputer(new AutomationService(admission));
  admission.fenced = true;
  const generation = service.getGeneration();
  const operations = [
    () => service.openBrowser('session', {}),
    () => service.commandBrowser('session', { action: 'reload' }),
    () => service.authorizeBrowser('session', {}),
    () => service.authorizeComputer('session', { tool: 'desktop_list_apps' }),
    () => service.callComputer('session', 'desktop_list_apps', {}),
    () => service.stopSession('session'),
    () => service.startBridge(),
    () => service.status(),
  ];
  for (const operation of operations) await assert.rejects(operation(), /fenced/);
  assert.equal(service.getGeneration(), generation);
  idle(service.snapshotActivity());
  idle(await service.browser.snapshotActivity());
  assert.equal(admission.active, 0);
});

test('a cancelled computer call is reported uncertain instead of success', async (t) => {
  const admission = new Admission();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const service = withComputer(new AutomationService(admission), (signal) => {
    markStarted();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  const controller = new AbortController();
  const call = service.callComputer('session', 'desktop_list_apps', {}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(call, /cancelled/);
  assert.equal(admission.active, 0);
});

test('a failing computer call surfaces the error and does not leave admission stuck', async () => {
  const service = withComputer(new AutomationService());
  let fail = true;
  Object.defineProperty(service, 'remoteComputerHub', {
    value: {
      call: async () => fail
        ? { isError: true, content: [{ text: 'tool failed' }] }
        : { structuredContent: { data: { apps: [] } } },
      readiness: () => READINESS,
    },
  });
  await assert.rejects(service.callComputer('session', 'desktop_list_apps', {}), /tool failed/);
  fail = false;
  await service.callComputer('session', 'desktop_list_apps', {});
  idle(service.snapshotActivity());
});

async function bridge(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'automation-admission-'));
  environment(t, { GAJAE_AUTOMATION_SOCKET: join(directory, 'bridge.sock') });
  const admission = new Admission();
  const service = withComputer(new AutomationService(admission));
  await service.startBridge();
  const socket = net.createConnection(process.env.GJC_AUTOMATION_SOCKET!);
  await once(socket, 'connect');
  t.after(async () => {
    socket.destroy();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const send = (token = process.env.GJC_AUTOMATION_TOKEN) => socket.write(`${JSON.stringify({
    id: 'request', token, sessionId: 'session', surface: 'browser', operation: 'open', payload: {},
  })}\n`);
  return { admission, service, socket, send };
}

test('direct Unix bridge authenticates before admission and rejects fenced dispatch', { skip: process.platform === 'win32' }, async (t) => {
  const { admission, service, socket, send } = await bridge(t);
  service.openBrowser = async () => { assert.fail('fenced bridge must not dispatch'); };
  admission.fenced = true;
  const count = admission.sources.length;
  send('invalid-token');
  let [data] = await once(socket, 'data');
  assert.match(data.toString(), /Unauthorized/);
  assert.equal(admission.sources.length, count);
  send();
  [data] = await once(socket, 'data');
  assert.match(data.toString(), /fenced/);
  assert.equal(admission.sources.at(-1), 'automation.bridge.request');
  idle(service.snapshotActivity());
});

test('bridge socket close cannot release an executing handler before its actual promise settles', { skip: process.platform === 'win32' }, async (t) => {
  const { admission, service, socket, send } = await bridge(t);
  let finish!: (value: unknown) => void;
  service.openBrowser = () => new Promise((resolve) => { finish = resolve; });
  send();
  await until(() => Boolean(finish));
  socket.destroy();
  await once(socket, 'close');
  assert.equal(admission.active, 1);
  assert.equal(service.snapshotActivity().running, 1);
  const generation = service.getGeneration();
  finish({ opened: false });
  await until(() => admission.active === 0);
  idle(service.snapshotActivity());
  assert.notEqual(service.getGeneration(), generation);
});
