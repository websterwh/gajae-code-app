import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AutomationGrantStore } from './automation-grants.js';
import { AutomationService, automationSupport } from './automation.service.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

const READINESS = {
  schemaSupported: true,
  daemon: 'running' as const,
  safeTools: ['desktop_list_apps', 'desktop_list_windows', 'desktop_focus_window', 'local_exec'],
  deviceName: 'test-host',
  os: 'linux x86_64',
};

type ComputerCall = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/**
 * A service whose selected computer is a real registry record and whose hub is
 * a recorder: everything above the transport (capability, authorization,
 * identity resolution) is the real implementation.
 */
function withComputer(
  service: AutomationService,
  call: ComputerCall = async () => ({ structuredContent: { data: { apps: [] } } }),
) {
  const devices = new RemoteComputerDeviceRegistry(memoryStorage());
  const registered = devices.registerUnattended('test-host', 'linux x86_64');
  devices.update(registered.device.id, { enabled: true, readiness: READINESS });
  devices.select(registered.device.id);
  Object.defineProperty(service, 'remoteDevices', { value: devices });
  let impl = call;
  const dispatched: Array<{ tool: string; args: Record<string, unknown> }> = [];
  Object.defineProperty(service, 'remoteComputerHub', {
    value: {
      call: async (_deviceId: string, _sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        dispatched.push({ tool, args });
        return impl(tool, args, signal);
      },
      readiness: () => READINESS,
      isConnected: () => true,
    },
  });
  return { service, devices, dispatched, setCall: (next: ComputerCall) => { impl = next; } };
}

test('only macOS desktop is a native browser candidate and computer support is companion-only', () => {
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
  const previous = { GAJAE_AUTOMATION_SOCKET: process.env.GAJAE_AUTOMATION_SOCKET };
  Object.assign(process.env, { GAJAE_AUTOMATION_SOCKET: socket });
  try {
    const { service } = withComputer(new AutomationService());
    await assert.rejects(service.startBridge(), { code: 'EADDRINUSE' });
    await service.shutdown();
    const client = net.createConnection(socket);
    const [data] = await once(client, 'data');
    assert.equal(data.toString(), 'existing owner');
    client.destroy();
  } finally {
    if (previous.GAJAE_AUTOMATION_SOCKET === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET;
    else process.env.GAJAE_AUTOMATION_SOCKET = previous.GAJAE_AUTOMATION_SOCKET;
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown closes idle automation clients instead of waiting forever for them', { skip: process.platform === 'win32', timeout: 2000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-bridge-idle-'));
  const socket = join(directory, 'automation.sock');
  const previous = { GAJAE_AUTOMATION_SOCKET: process.env.GAJAE_AUTOMATION_SOCKET };
  Object.assign(process.env, { GAJAE_AUTOMATION_SOCKET: socket });
  const { service } = withComputer(new AutomationService());
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
    if (previous.GAJAE_AUTOMATION_SOCKET === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET;
    else process.env.GAJAE_AUTOMATION_SOCKET = previous.GAJAE_AUTOMATION_SOCKET;
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser authorization is origin-scoped and can persist for one session', async () => {
  const service = withComputer(new AutomationService()).service;
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
});

test('browser authorization resolves the active tab when a tool action has no URL', async () => {
  const service = withComputer(new AutomationService()).service;
  service.browser.status = async () => ({ state: 'ready', ready: true, engine: 'webview' });
  const binding = { windowEpoch: 'native-window', documentEpoch: 1, origin: 'https://docs.example.test' };
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
});

test('computer authorization resolves a pid to a bundle identity and scopes the grant', async () => {
  const { service, setCall } = withComputer(new AutomationService());
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
  setCall(async (tool) => tool === 'desktop_list_windows'
    ? { structuredContent: { data: { windows: [{ pid: 42, id: 'w-1', title: 'TextEdit' }] } } }
    : { structuredContent: { data: { apps: [{ pid: 42, name: 'TextEdit' }] } } });

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
});

test('computer authorization resolves a window id to its owning application', async () => {
  const { service, setCall } = withComputer(new AutomationService());
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
  setCall(async (tool) => {
    if (tool === 'desktop_list_windows') {
      return { structuredContent: { data: { windows: [{ pid: 42, id: 'w-readme', title: 'README.md' }] } } };
    }
    return { structuredContent: { data: { apps: [{ pid: 42, name: 'TextEdit' }] } } };
  });

  assert.deepEqual(
    await service.authorizeComputer('session-a', {
      tool: 'desktop_focus_window',
      arguments: { window_id: 'w-readme' },
    }),
    { granted: false, application: 'TextEdit', label: 'TextEdit' },
  );
});

test('computer discovery does not require an application grant', async () => {
  const service = withComputer(new AutomationService()).service;
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
  assert.deepEqual(
    await service.authorizeComputer('session-a', { tool: 'desktop_list_apps', arguments: {} }),
    { granted: true, application: null, label: null },
  );
});

test('stopping a session closes browser work and revokes only session grants', async () => {
  const service = withComputer(new AutomationService()).service;
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

  assert.deepEqual(await service.stopSession('session-a'), { closed: true });
  assert.deepEqual(calls, ['browser.close']);
  assert.deepEqual(grants.list('session-a').session, []);
  assert.deepEqual(grants.list().always.applications, ['com.example.Persistent']);
});

test('disconnecting an automation bridge client cancels its in-flight computer request', async () => {
  const previousSocket = process.env.GJC_AUTOMATION_SOCKET;
  const previousToken = process.env.GJC_AUTOMATION_TOKEN;
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const { service } = withComputer(new AutomationService(), async (_tool, _args, signal) => {
    assert.ok(signal);
    markStarted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        markAborted();
        reject(new Error('cancelled'));
      }, { once: true });
    });
  });
  try {
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
    if (previousSocket === undefined) delete process.env.GJC_AUTOMATION_SOCKET;
    else process.env.GJC_AUTOMATION_SOCKET = previousSocket;
    if (previousToken === undefined) delete process.env.GJC_AUTOMATION_TOKEN;
    else process.env.GJC_AUTOMATION_TOKEN = previousToken;
  }
});

test('a disabled selected device refuses computer calls instead of falling back to a local driver', async () => {
  const { service, devices } = withComputer(new AutomationService());
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
  const selected = devices.selectedDeviceId()!;
  devices.update(selected, { enabled: false });

  await assert.rejects(
    service.callComputer('session-a', 'desktop_list_apps', {}),
    /No computer automation transport is available/u,
  );
  assert.equal((await service.status()).computerSupported, false);
});

test('a non-macOS server is computer-capable once a remote device is paired and selected', async () => {
  const service = withComputer(new AutomationService()).service;
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });

  await service.callComputer('session-a', 'desktop_list_apps', {});
  const status = await service.status();
  assert.equal(status.computerSupported, true, 'status reports computer-capable from the selected remote device alone');
});

test('a server with no paired companion refuses computer calls', async () => {
  const service = new AutomationService();
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore(memoryStorage()) });
  await assert.rejects(
    service.callComputer('session-a', 'desktop_list_apps', {}),
    /No computer automation transport is available/u,
  );
  assert.equal((await service.status()).computerSupported, false);
});
