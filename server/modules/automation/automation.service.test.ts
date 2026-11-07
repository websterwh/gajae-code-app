import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AutomationGrantStore } from './automation-grants.js';
import { AutomationService, automationSupport } from './automation.service.js';
import { ComputerUseStore } from './computer-use.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

/**
 * Computer use is an opt-in that is off by default (#131). These tests are
 * about what a session may do once the user turned it on, so they turn it on;
 * the default and its refusal have their own test below.
 */
function withComputerUse(service: AutomationService, enabled = true): AutomationService {
  const store = new ComputerUseStore(memoryStorage());
  store.set(enabled);
  Object.defineProperty(service, 'computerUse', { value: store });
  return service;
}

test('only macOS desktop is a native browser candidate and CUA retains its own platform policy', () => {
  assert.deepEqual(automationSupport('linux', 'x64', { GJC_DESKTOP: '1' }), { browser: false, computer: false });
  assert.deepEqual(automationSupport('darwin', 'arm64', { GJC_DESKTOP: '1' }), { browser: true, computer: true });
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']] as const) {
    assert.deepEqual(automationSupport(platform, arch, { GJC_DESKTOP: '1' }), { browser: false, computer: false });
  }
  assert.deepEqual(automationSupport('linux', 'x64', {}), { browser: false, computer: false });
  assert.deepEqual(automationSupport('linux', 'x64', { GAJAE_AUTOMATION: '1' }), { browser: false, computer: true });
});

test('shutdown of an unstarted service preserves an existing configured socket path and another bridge environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-bridge-owner-'));
  const socket = join(directory, 'automation.sock');
  await writeFile(socket, 'owned by another instance');
  const previous = { GAJAE_AUTOMATION_SOCKET: process.env.GAJAE_AUTOMATION_SOCKET, GJC_AUTOMATION_SOCKET: process.env.GJC_AUTOMATION_SOCKET, GJC_AUTOMATION_TOKEN: process.env.GJC_AUTOMATION_TOKEN };
  Object.assign(process.env, { GAJAE_AUTOMATION_SOCKET: socket, GJC_AUTOMATION_SOCKET: socket, GJC_AUTOMATION_TOKEN: 'another-bridge' });
  try {
    await new AutomationService().shutdown();
    assert.equal(await readFile(socket, 'utf8'), 'owned by another instance');
    assert.equal(process.env.GJC_AUTOMATION_TOKEN, 'another-bridge');
    assert.equal(process.env.GJC_AUTOMATION_SOCKET, socket);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('starting on an occupied Unix socket fails without disconnecting its existing owner', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-bridge-in-use-'));
  const socket = join(directory, 'automation.sock');
  const owner = net.createServer(client => client.end('existing owner'));
  owner.listen(socket);
  await once(owner, 'listening');
  const previous = { GAJAE_AUTOMATION: process.env.GAJAE_AUTOMATION, GAJAE_AUTOMATION_SOCKET: process.env.GAJAE_AUTOMATION_SOCKET };
  Object.assign(process.env, { GAJAE_AUTOMATION: '1', GAJAE_AUTOMATION_SOCKET: socket });
  try {
    const service = withComputerUse(new AutomationService());
    await assert.rejects(service.startBridge(), { code: 'EADDRINUSE' });
    await service.shutdown();
    const client = net.createConnection(socket);
    const [data] = await once(client, 'data');
    assert.equal(data.toString(), 'existing owner');
    client.destroy();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown closes idle automation clients instead of waiting forever for them', { skip: process.platform === 'win32', timeout: 2000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-bridge-idle-'));
  const socket = join(directory, 'automation.sock');
  const previous = { GAJAE_AUTOMATION: process.env.GAJAE_AUTOMATION, GAJAE_AUTOMATION_SOCKET: process.env.GAJAE_AUTOMATION_SOCKET };
  Object.assign(process.env, { GAJAE_AUTOMATION: '1', GAJAE_AUTOMATION_SOCKET: socket });
  const service = withComputerUse(new AutomationService());
  let client: net.Socket | undefined;
  try {
    await service.startBridge();
    client = net.createConnection(socket);
    await once(client, 'connect');
    const closed = once(client, 'close');
    await service.shutdown();
    await closed;
    await assert.rejects(readFile(socket), { code: 'ENOENT' });
  } finally {
    client?.destroy();
    await service.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser authorization is origin-scoped and can persist for one session', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    service.browser.status = async () => ({ state: 'ready', ready: true, engine: 'webview' });
    service.browser.state = async () => ({sessionId: 'session-a', activeTabId: null, tabs: [], binding: null, profileMode: 'persistent'});
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });

    assert.deepEqual(
      await service.authorizeBrowser('session-a', { url: 'https://example.com/private?q=1' }),
      { granted: false, origin: 'https://example.com', binding: null },
    );
    assert.deepEqual(
      await service.authorizeBrowser('session-a', { url: 'https://example.com/other', scope: 'session' }),
      { granted: true, origin: 'https://example.com', binding: null },
    );
    assert.equal(
      (await service.authorizeBrowser('session-b', { url: 'https://example.com' })).granted,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('browser authorization resolves the active tab when a tool action has no URL', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    service.browser.status = async () => ({ state: 'ready', ready: true, engine: 'webview' });
    const binding = { windowEpoch: 'native-window', documentEpoch: 1, origin: 'https://docs.example.test' };
    service.browser.state = async () => ({sessionId: 'session-a', activeTabId: null, tabs: [], binding: null, profileMode: 'persistent'});
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    service.browser.state = async () => ({
      binding, profileMode: 'persistent',
      sessionId: 'session-a',
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: 'Docs', url: 'https://docs.example.test/guide', loading: false, canGoBack: false, canGoForward: false }],
    });

    assert.deepEqual(
      await service.authorizeBrowser('session-a', {}),
      { granted: false, origin: 'https://docs.example.test', binding },
    );
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('computer authorization resolves a pid to a bundle identity and scopes the grant', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    service.cua.call = async (tool) => {
      assert.equal(tool, 'desktop_list_windows');
      return {
        structuredContent: {
          data: { windows: [{ pid: 42, id: 'w-1', title: 'TextEdit' }] },
        },
      };
    };
    const cuaApps = service.cua.call;
    service.cua.call = async (tool, args) => {
      if (tool === 'desktop_list_apps') {
        return { structuredContent: { data: { apps: [{ pid: 42, name: 'TextEdit' }] } } };
      }
      return cuaApps(tool, args);
    };

    assert.deepEqual(
      await service.authorizeComputer('session-a', { tool: 'desktop_focus_window', arguments: { window_id: 'w-1' } }),
      { granted: false, application: 'TextEdit', label: 'TextEdit' },
    );
    assert.deepEqual(
      await service.authorizeComputer('session-a', { tool: 'desktop_focus_window', arguments: { window_id: 'w-1' }, scope: 'session' }),
      { granted: true, application: 'TextEdit', label: 'TextEdit' },
    );
    assert.equal(
      (await service.authorizeComputer('session-b', { tool: 'desktop_focus_window', arguments: { window_id: 'w-1' } })).granted,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('computer authorization resolves a window id to its owning application', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    service.cua.call = async (tool) => {
      if (tool === 'desktop_list_windows') {
        return { structuredContent: { data: { windows: [{ pid: 42, id: 'w-readme', title: 'README.md' }] } } };
      }
      assert.equal(tool, 'desktop_list_apps');
      return { structuredContent: { data: { apps: [{ pid: 42, name: 'TextEdit' }] } } };
    };

    assert.deepEqual(
      await service.authorizeComputer('session-a', {
        tool: 'desktop_focus_window',
        arguments: { window_id: 'w-readme' },
      }),
      { granted: false, application: 'TextEdit', label: 'TextEdit' },
    );
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('computer discovery does not require an application grant', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    assert.deepEqual(
      await service.authorizeComputer('session-a', { tool: 'desktop_list_apps', arguments: {} }),
      { granted: true, application: null, label: null },
    );
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('stopping a session closes browser and CUA work and revokes only session grants', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    const grants = new AutomationGrantStore(memoryStorage());
    Object.defineProperty(service, 'grants', { value: grants });
    grants.grant({ kind: 'origin', value: 'https://session.example', scope: 'session', sessionId: 'session-a' });
    grants.grant({ kind: 'application', value: 'com.example.Persistent', scope: 'always' });

    const calls: string[] = [];
    service.browser.close = async (sessionId, signal) => {
      assert.equal(sessionId, 'session-a');
      assert.equal(signal?.aborted, false);
      calls.push('browser.close');
      return { closed: true };
    };
    service.cua.call = async (tool) => {
      assert.equal(tool, 'desktop_list_apps');
      return { structuredContent: { data: { apps: [] } } };
    };

    await service.callComputer('session-a', 'desktop_list_apps', {});

    assert.deepEqual(await service.stopSession('session-a'), { closed: true });
    assert.deepEqual(calls, ['browser.close']);
    assert.deepEqual(grants.list('session-a').session, []);
    assert.deepEqual(grants.list().always.applications, ['com.example.Persistent']);
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('disconnecting an automation bridge client cancels its in-flight CUA request', async () => {
  const previousAutomation = process.env.GAJAE_AUTOMATION;
  const previousSocket = process.env.GJC_AUTOMATION_SOCKET;
  const previousToken = process.env.GJC_AUTOMATION_TOKEN;
  process.env.GAJAE_AUTOMATION = '1';
  const service = withComputerUse(new AutomationService());
  try {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    service.cua.call = async (tool, _args, signal) => {
      assert.equal(tool, 'desktop_list_apps');
      assert.ok(signal);
      markStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          markAborted();
          reject(new Error('cancelled'));
        }, { once: true });
      });
    };

    await service.startBridge();
    const socketPath = process.env.GJC_AUTOMATION_SOCKET;
    const token = process.env.GJC_AUTOMATION_TOKEN;
    assert.ok(socketPath);
    assert.ok(token);
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({
      id: 'disconnect-request',
      token,
      surface: 'computer',
      sessionId: 'session-a',
      tool: 'desktop_list_apps',
      arguments: {},
    })}\n`);
    await started;
    socket.destroy();
    await aborted;
  } finally {
    await service.shutdown();
    if (previousAutomation === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previousAutomation;
    if (previousSocket === undefined) delete process.env.GJC_AUTOMATION_SOCKET;
    else process.env.GJC_AUTOMATION_SOCKET = previousSocket;
    if (previousToken === undefined) delete process.env.GJC_AUTOMATION_TOKEN;
    else process.env.GJC_AUTOMATION_TOKEN = previousToken;
  }
});

test('computer use is off by default and every computer path refuses until the user turns it on', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService(), false);
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    let driverCalls = 0;
    service.cua.call = async () => { driverCalls += 1; return { structuredContent: { data: { apps: [] } } }; };

    // The platform capability is present; the opt-in alone gates the call.
    const refused = /Computer use is off/u;
    await assert.rejects(service.authorizeComputer('session-a', { tool: 'desktop_click', arguments: { ref_id: '@s1:e1' } }), refused);
    await assert.rejects(service.callComputer('session-a', 'desktop_list_apps', {}), refused);
    await assert.rejects(service.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-1' }), refused);
    assert.equal(driverCalls, 0, 'a refused call never reaches the driver');

    service.computerUse.set(true);
    await assert.doesNotReject(service.callComputer('session-a', 'desktop_list_apps', {}));
    assert.ok(driverCalls > 0);
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('selecting a paired remote device routes computer calls to it instead of the local driver', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  try {
    const service = withComputerUse(new AutomationService());
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    const registry = new RemoteComputerDeviceRegistry(memoryStorage());
    Object.defineProperty(service, 'remoteDevices', { value: registry });
    const paired = registry.consumePairing(registry.issuePairing().token, 'Laptop', 'darwin');
    registry.update(paired.device.id, { enabled: true });
    registry.select(paired.device.id);

    let localCalls = 0;
    const remoteTools: string[] = [];
    service.cua.call = async () => { localCalls += 1; return { structuredContent: { data: { apps: [] } } }; };
    Object.defineProperty(service, 'remoteComputerHub', {
      value: {
        call: async (deviceId: string, appSessionId: string, tool: string) => {
          remoteTools.push(tool);
          assert.equal(deviceId, paired.device.id);
          assert.equal(appSessionId, 'session-a');
          return { apps: [] };
        },
        readiness: () => undefined,
        devices: registry,
      },
    });

    await service.callComputer('session-a', 'desktop_list_apps', {});
    assert.deepEqual(remoteTools, ['desktop_list_apps'], 'the selected remote device received the call');
    assert.equal(localCalls, 0, 'the local driver was never consulted while a device is selected');

    // Disabling the selected device after selection falls back to local
    // instead of throwing, since dispatchable() re-checks on every call.
    registry.update(paired.device.id, { enabled: false });
    await service.callComputer('session-a', 'desktop_list_apps', {});
    assert.ok(localCalls > 0, 'a disabled selected device falls back to the local driver');
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});

test('a non-macOS server with no GAJAE_AUTOMATION override is still computer-capable once a remote device is paired and selected', async () => {
  const previous = process.env.GAJAE_AUTOMATION;
  delete process.env.GAJAE_AUTOMATION;
  try {
    const service = withComputerUse(new AutomationService());
    Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
    const registry = new RemoteComputerDeviceRegistry(memoryStorage());
    Object.defineProperty(service, 'remoteDevices', { value: registry });

    // No local platform capability and no override: computer calls must
    // still fail closed with no device selected.
    await assert.rejects(service.callComputer('session-a', 'desktop_list_apps', {}), /No computer automation transport is available/u);

    const paired = registry.consumePairing(registry.issuePairing().token, 'Laptop', 'darwin arm64');
    registry.update(paired.device.id, { enabled: true });
    registry.select(paired.device.id);

    const remoteTools: string[] = [];
    Object.defineProperty(service, 'remoteComputerHub', {
      value: {
        call: async (deviceId: string, appSessionId: string, tool: string) => {
          remoteTools.push(tool);
          assert.equal(deviceId, paired.device.id);
          assert.equal(appSessionId, 'session-a');
          return { apps: [] };
        },
        readiness: () => undefined,
        devices: registry,
      },
    });

    // Selecting a working remote device makes the server computer-capable
    // purely from pairing state, with no platform override of any kind.
    await service.callComputer('session-a', 'desktop_list_apps', {});
    assert.deepEqual(remoteTools, ['desktop_list_apps']);

    const status = await service.status();
    assert.equal(status.computerSupported, true, 'status reports computer-capable from the selected remote device alone');
  } finally {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  }
});
