import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';


import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import {
  AutomationService, configureDesktopRestartAdmission, createAutomationDesktopRestartReader,
  createBrowserDesktopRestartReader, createComputerDesktopRestartReader,
} from './automation.service.js';
import { AgentDesktopClient } from './agent-desktop-client.js';
import { ComputerUseStore } from './computer-use.js';

/** Computer use is off by default (#131); these tests exercise live computer work, so it is on. */
function withComputerUse(service: AutomationService): AutomationService {
  const values = new Map<string, string>();
  const store = new ComputerUseStore({ get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); } });
  store.set(true);
  Object.defineProperty(service, 'computerUse', { value: store });
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

type WireRequest = {
  id: string;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode = null;
  kills = 0;
  calls: WireRequest[] = [];
  constructor() {
    super();
    this.stdin.on('data', (bytes: Buffer) => {
      for (const line of bytes.toString().trim().split('\n')) this.calls.push(JSON.parse(line) as WireRequest);
    });
  }
  kill(): boolean { this.kills++; return true; }
  close(): void {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0);
  }
  reply(request: WireRequest, result: unknown = { ok: true }): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
}

function children(t: TestContext) {
  const processes: FakeChild[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new FakeChild();
    processes.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of processes) if (child.exitCode === null) child.close();
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return { processes, spawn };
}

function environment(t: TestContext, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
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

async function initializeAgentDesktop(fixture: ReturnType<typeof children>) {
  await until(() => Boolean(fixture.processes.at(-1)?.calls.length));
  const child = fixture.processes.at(-1)!;
  assert.equal(child.calls[0]!.method, 'initialize');
  child.reply(child.calls[0]!, {
    capabilities: { tools: {} },
    serverInfo: { name: 'agent-desktop', version: '1.2.0' },
  });
  await until(() => child.calls.some((call) => call.method === 'tools/call'));
  return child;
}

test('agent-desktop client rejects an unknown schema before tool dispatch', async (t) => {
  environment(t, { AGENT_DESKTOP_PATH: process.execPath });
  const fixture = children(t);
  const client = new AgentDesktopClient();
  const call = client.call('desktop_list_apps', {});
  await until(() => Boolean(fixture.processes.at(-1)?.calls.length));
  const child = fixture.processes.at(-1)!;
  assert.equal(child.calls[0]!.method, 'initialize');
  child.reply(child.calls[0]!, { capabilities: { tools: {} } });
  await assert.rejects(call, { message: /Unsupported agent-desktop schema unknown/u });
  assert.equal(child.calls.some((request) => request.method === 'tools/call'), false);
});

test('all three readers are pure, complete for healthy unused owners, and independent snapshots', async (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const service = withComputerUse(new AutomationService());
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
  assert.equal(fixture.spawn.mock.callCount(), 0);
  assert.deepEqual(admission.sources, []);
});

test('fenced direct service and client producers reject before startup or dispatch', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1', AGENT_DESKTOP_PATH: process.execPath });
  const fixture = children(t);
  const admission = new Admission();
  const service = withComputerUse(new AutomationService(admission));
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
    () => service.cua.call('desktop_list_apps', {}),
    () => service.cua.status(),
  ];
  for (const operation of operations) await assert.rejects(operation(), /fenced/);
  assert.equal(fixture.spawn.mock.callCount(), 0);
  assert.equal(service.getGeneration(), generation);
  idle(service.snapshotActivity());
  idle(await service.browser.snapshotActivity());
  idle(service.cua.snapshotActivity());
  assert.equal(admission.active, 0);
});

test('a cancelled computer call is reported uncertain and transport exit is treated as unconfirmed, not success', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1', AGENT_DESKTOP_PATH: process.execPath });
  const fixture = children(t);
  const admission = new Admission();
  const service = withComputerUse(new AutomationService(admission));
  const controller = new AbortController();
  const call = service.callComputer('session', 'desktop_list_apps', {}, controller.signal);
  assert.ok(service.cua.snapshotActivity().starting > 0 || service.cua.snapshotActivity().running > 0);
  const child = await initializeAgentDesktop(fixture);
  const rejected = assert.rejects(call, /cancelled/);
  controller.abort();
  await rejected;
  assert.ok(child.calls.some((request) => request.method === 'notifications/cancelled'));
  assert.equal(admission.active, 0);
});

test('agent-desktop requests that time out survive transport exit and a replacement process', async (t) => {
  environment(t, { AGENT_DESKTOP_PATH: process.execPath });
  const fixture = children(t);
  const client = new AgentDesktopClient();
  const first = client.call('desktop_list_apps', {});
  const oldChild = await initializeAgentDesktop(fixture);
  oldChild.reply(oldChild.calls.at(-1)!);
  await first;
  const request = client as unknown as {
    request(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown>;
  };
  await assert.rejects(request.request('tools/call', { name: 'desktop_list_apps', arguments: {} }, 5), /timed out/);
  assert.equal(client.snapshotActivity().complete, false);
  oldChild.close();
  const next = client.call('desktop_list_apps', {});
  await until(() => fixture.processes.length === 2);
  const child = await initializeAgentDesktop(fixture);
  child.reply(child.calls.at(-1)!);
  await next;
  assert.equal(client.snapshotActivity().running, 0);
  assert.deepEqual(client.snapshotActivity().unknown, ['agent_desktop_request_unconfirmed']);
});

test('a failing computer call surfaces the driver error and does not leave admission stuck', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1' });
  const service = withComputerUse(new AutomationService());
  let fail = true;
  service.cua.call = async () => fail
    ? { isError: true, content: [{ text: 'tool failed' }] } : { structuredContent: { data: { apps: [] } } };
  await assert.rejects(service.callComputer('session', 'desktop_list_apps', {}), /tool failed/);
  fail = false;
  await service.callComputer('session', 'desktop_list_apps', {});
  idle(service.snapshotActivity());
});

async function bridge(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'automation-admission-'));
  environment(t, { GAJAE_AUTOMATION: '1', GAJAE_AUTOMATION_SOCKET: join(directory, 'bridge.sock') });
  const admission = new Admission();
  const service = withComputerUse(new AutomationService(admission));
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
