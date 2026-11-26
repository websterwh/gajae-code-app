import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import english from '../../../../i18n/locales/en/settings.json';
import { resetAppShellStore, useAppShellStore } from '../../../../stores/useAppShellStore';
import type { Project } from '../../../../types/app';

import AutomationSettingsTab from './AutomationSettingsTab';

type Call = { path: string; method: string; body?: unknown };
type ApiOptions = {
  backend?: 'builtin' | 'aside' | 'ego';
  egoActivity?: boolean;
  egoFrames?: boolean;
  rejectBackendSave?: boolean;
  browserOpen?: Response | Error;
  browserReady?: boolean;
  grants?: { always: { origins: string[]; applications: string[] } };
  /** Answer /api/host/* for real; left out, the tab sees no host surface at all. */
  hostControl?: {
    enabled: boolean;
    capabilities: Record<string, boolean>;
    host: { os: string; kernelVersion: string; platform: { id: string; label: string } | null; detectedAt: number } | null;
    ssh?: {
      host: string;
      port: number;
      user: string;
      hostKey: string;
      keyPresent: boolean;
      writePreauthorized: boolean;
    };
  };
};

const originalFetch = globalThis.fetch;
const originalWindowOpen = window.open;
const project: Project = { projectId: 'project-a', displayName: 'Alpha', fullPath: '/work/alpha' };

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.open = originalWindowOpen;
  resetAppShellStore();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function fakeApi(options: ApiOptions = {}) {
  const calls: Call[] = [];
  let backend = options.backend ?? 'builtin';
  let egoActivity = options.egoActivity ?? false;
  let egoFrames = options.egoFrames ?? false;
  let grants = options.grants ?? { always: { origins: [], applications: [] } };
  const hostControl = options.hostControl;
  const hostStatus = () => ({
    available: true,
    socketPath: '/var/run/docker.sock',
    reachable: true,
    enabled: hostControl?.enabled === true,
    capabilities: hostControl?.capabilities ?? {},
    targets: [],
    host: hostControl?.host ?? null,
    ...(hostControl?.ssh ? { ssh: hostControl.ssh } : {}),
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    if (path === '/api/automation/status') {
      return new Response(JSON.stringify({
        supported: true,
        platform: 'darwin',
        architecture: 'arm64',
        capabilities: { browser: options.browserReady ?? true, computer: true },
        browser: {},
      }));
    }
    if (path === '/api/automation/grants') {
      if (method === 'DELETE') {
        const target = body as { kind: 'origin' | 'application'; value: string };
        grants = { always: {
          origins: grants.always.origins.filter((value) => target.kind !== 'origin' || value !== target.value),
          applications: grants.always.applications.filter((value) => target.kind !== 'application' || value !== target.value),
        } };
      }
      return new Response(JSON.stringify(grants));
    }
    if (path === '/api/automation/browser-backend') {
      if (method === 'PUT') {
        if (options.rejectBackendSave) return new Response(JSON.stringify({ error: 'rejected' }), { status: 400 });
        backend = (body as { backend: 'builtin' | 'aside' | 'ego' }).backend;
      }
      return new Response(JSON.stringify({ backend, backends: ['builtin', 'aside', 'ego'] }));
    }
    if (path === '/api/automation/ego-activity') {
      if (method === 'PUT') {
        const update = body as { enabled?: boolean; frames?: boolean };
        if ('enabled' in update) egoActivity = update.enabled === true;
        if ('frames' in update) egoFrames = update.frames === true;
        return new Response(JSON.stringify({ ...('enabled' in update ? { enabled: egoActivity } : {}), ...('frames' in update ? { frames: egoFrames } : {}) }));
      }
      // Without a session id the route reports the stored opt-ins and observes nothing.
      return new Response(JSON.stringify({
        configured: egoActivity, enabled: egoActivity,
        framesConfigured: egoFrames, frames: egoActivity && egoFrames,
        supported: true, backend, spaces: [],
      }));
    }
    if (path === '/api/automation/remote-computers') {
      return new Response(JSON.stringify({ devices: [], companionDownloadTemplate: null }));
    }
    if (hostControl && path === '/api/host/status') {
      return new Response(JSON.stringify(hostStatus()));
    }
    if (hostControl && path === '/api/host/settings' && method === 'PUT') {
      const wasReading = hostControl.enabled && hostControl.capabilities.discovery === true;
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value !== 'boolean') continue;
        if (key === 'enabled') hostControl.enabled = value;
        else hostControl.capabilities[key] = value;
      }
      // The server detects on the transition into reading and answers in the
      // same response; the fake does the same so the tab's real render path runs.
      if (!wasReading && hostControl.enabled && hostControl.capabilities.discovery === true) {
        hostControl.host = {
          os: 'Devuan GNU/Linux 6 (excalibur)', kernelVersion: '6.12.10-mos',
          platform: { id: 'mos', label: 'MOS' }, detectedAt: 1,
        };
      }
      return new Response(JSON.stringify(hostStatus()));
    }
    if (hostControl && path === '/api/host/ssh/keys' && method === 'POST') {
      hostControl.ssh = { ...(hostControl.ssh ?? { host: '', port: 22, user: 'root', hostKey: '', writePreauthorized: false }), keyPresent: true };
      return new Response(JSON.stringify({ publicKey: 'ssh-ed25519 AAAAgenerated gajae-host-control' }));
    }
    if (hostControl && path === '/api/host/ssh/host-key' && method === 'POST') {
      const target = body as { host?: string; port?: number };
      // The route saves the address it scanned and pins the key when none was.
      hostControl.ssh = {
        host: target.host ?? hostControl.ssh?.host ?? '',
        port: target.port ?? hostControl.ssh?.port ?? 22,
        user: hostControl.ssh?.user ?? 'root',
        hostKey: 'ssh-ed25519 AAAAscanned destination',
        keyPresent: hostControl.ssh?.keyPresent ?? false,
        writePreauthorized: hostControl.ssh?.writePreauthorized ?? false,
      };
      return new Response(JSON.stringify({ hostKey: hostControl.ssh.hostKey, scannedHostKey: hostControl.ssh.hostKey }));
    }
    if (hostControl && path === '/api/host/discovery') {
      const detectedAt = 1;
      hostControl.host = {
        os: 'Devuan GNU/Linux 6 (excalibur)', kernelVersion: '6.12.10-mos',
        platform: { id: 'mos', label: 'MOS' }, detectedAt,
      };
      return new Response(JSON.stringify({
        detectedAt,
        profile: {
          runtime: { serverVersion: '28.0.0', operatingSystem: 'Devuan GNU/Linux 6 (excalibur)', kernelVersion: '6.12.10-mos', driver: 'overlay2', swarm: 'inactive', hostName: 'webby' },
          platforms: [{ id: 'mos', label: 'MOS', kind: 'os', evidence: ['host reports "Devuan GNU/Linux 6 (excalibur) 6.12.10-mos"'] }],
          managers: [], socketHolders: [], stacks: [], unmanaged: [], guidance: [],
        },
      }));
    }
    if (path === '/api/automation/remote-computers/pairings' && method === 'POST') {
      return new Response(JSON.stringify({ token: 'fake-pairing-token' }));
    }
    if (path.startsWith('/api/browser/') && method === 'POST') {
      if (options.browserOpen instanceof Error) throw options.browserOpen;
      return options.browserOpen ?? new Response(JSON.stringify({
        sessionId: decodeURIComponent(path.split('/')[3]),
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', loading: false, canGoBack: false, canGoForward: false }],
        binding: { windowEpoch: 'window-1', documentEpoch: 1, origin: 'https://example.com' },
        profileMode: 'persistent',
      }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function mount() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { settings: english } },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i18n}><AutomationSettingsTab /></I18nextProvider>);
}

const backendSelect = () => screen.getByRole('combobox', { name: english.automation.browserBackend.label }) as HTMLSelectElement;

test('Built-in is the default and every backend choice persists through the API', async () => {
  const calls = fakeApi();
  await mount();
  await waitFor(() => assert.equal(backendSelect().disabled, false));

  assert.equal(backendSelect().value, 'builtin');
  assert.deepEqual([...backendSelect().options].map((option) => [option.value, option.textContent]), [
    ['builtin', english.automation.browserBackend.builtin],
    ['aside', english.automation.browserBackend.aside],
    ['ego', english.automation.browserBackend.ego],
  ]);

  fireEvent.change(backendSelect(), { target: { value: 'aside' } });
  await waitFor(() => assert.equal(backendSelect().value, 'aside'));
  assert.equal(screen.queryByRole('switch', { name: english.automation.browserBackend.activity }), null, 'the activity switches stay ego-only');

  fireEvent.change(backendSelect(), { target: { value: 'ego' } });
  await waitFor(() => assert.equal(backendSelect().value, 'ego'));
  assert.ok(screen.getByRole('switch', { name: english.automation.browserBackend.activity }));

  fireEvent.change(backendSelect(), { target: { value: 'builtin' } });
  await waitFor(() => assert.equal(backendSelect().value, 'builtin'));
  assert.equal(screen.queryByRole('switch', { name: english.automation.browserBackend.activity }), null);
  assert.deepEqual(calls.filter((call) => call.method === 'PUT').map((call) => call.body), [
    { backend: 'aside' },
    { backend: 'ego' },
    { backend: 'builtin' },
  ]);
});

test('the browser activity opt-in belongs to ego, is off by default and persists through the API', async () => {
  const calls = fakeApi({ backend: 'builtin' });
  await mount();
  await waitFor(() => assert.equal(backendSelect().disabled, false));

  const activityLabel = english.automation.browserBackend.activity;
  assert.equal(screen.queryByRole('switch', { name: activityLabel }), null, 'the surface exists only for the ego backend');

  fireEvent.change(backendSelect(), { target: { value: 'ego' } });
  const toggle = await screen.findByRole('switch', { name: activityLabel });
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'rendering a logged-in browser is never on by default');

  fireEvent.click(toggle);
  await waitFor(() => assert.equal(screen.getByRole('switch', { name: activityLabel }).getAttribute('aria-checked'), 'true'));
  assert.deepEqual(calls.filter((call) => call.path === '/api/automation/ego-activity' && call.method === 'PUT').map((call) => call.body), [{ enabled: true }]);

  // Reading the opt-in never asks for a session, so Settings observes no browser.
  assert.equal(calls.some((call) => call.path.startsWith('/api/automation/ego-activity?')), false);

  fireEvent.change(backendSelect(), { target: { value: 'builtin' } });
  // Compare a boolean, not the element: every failed retry formats its
  // message, and inspecting a mounted element walks the React fiber tree
  // (about 0.5 s here, past the 5 s test timeout on a loaded CI runner).
  await waitFor(() => assert.equal(screen.queryByRole('switch', { name: activityLabel }) === null, true));
});

test('the picture is a second switch: off by default and unavailable until activity is on', async () => {
  const calls = fakeApi({ backend: 'ego' });
  await mount();
  const activity = english.automation.browserBackend.activity;
  const frame = english.automation.browserBackend.activityFrame;

  const frameToggle = await screen.findByRole('switch', { name: frame });
  assert.equal(frameToggle.getAttribute('aria-checked'), 'false');
  // Seeing an address is not agreeing to see the page, so the picture cannot be
  // switched on before the surface it lives in.
  assert.equal((frameToggle as HTMLButtonElement).disabled, true);

  fireEvent.click(screen.getByRole('switch', { name: activity }));
  await waitFor(() => assert.equal((screen.getByRole('switch', { name: frame }) as HTMLButtonElement).disabled, false));

  fireEvent.click(screen.getByRole('switch', { name: frame }));
  await waitFor(() => assert.equal(screen.getByRole('switch', { name: frame }).getAttribute('aria-checked'), 'true'));
  assert.deepEqual(calls.filter((call) => call.method === 'PUT' && call.path === '/api/automation/ego-activity').map((call) => call.body), [
    { enabled: true },
    { frames: true },
  ]);
});

test('a rejected backend save keeps the persisted choice and reports the failure', async () => {
  fakeApi({ backend: 'aside', rejectBackendSave: true });
  await mount();
  await waitFor(() => assert.equal(backendSelect().value, 'aside'));

  fireEvent.change(backendSelect(), { target: { value: 'builtin' } });
  await waitFor(() => assert.equal(screen.getByRole('alert').textContent, english.automation.browserBackend.saveFailed));
  assert.equal(backendSelect().value, 'aside');
});

test('plain web hides desktop launch while saved grants remain usable', async () => {
  const calls = fakeApi({ grants: { always: { origins: ['https://example.com'], applications: ['Safari'] } } });
  await mount();
  await waitFor(() => assert.equal(backendSelect().disabled, false));

  assert.equal(screen.queryByRole('button', { name: english.automation.builtinBrowser.open }), null);
  assert.ok(screen.getByText('https://example.com'));
  assert.ok(screen.getByText('Safari'));

  fireEvent.click(screen.getAllByRole('button', { name: english.automation.revoke })[0]!);
  await waitFor(() => assert.equal(screen.queryByText('https://example.com') === null, true));
  assert.deepEqual(calls.find((call) => call.method === 'DELETE')?.body, {
    kind: 'origin', value: 'https://example.com', scope: 'always',
  });
});

test('desktop launch uses the selected app session and exposes an API failure without another open request', async () => {
  useAppShellStore.setState({ selectedProject: project, selectedSession: { id: 'session/a' } });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  let externalOpens = 0;
  window.open = (() => { externalOpens += 1; return null; }) as typeof window.open;
  const calls = fakeApi({ browserOpen: new Response(JSON.stringify({ error: 'builtin_browser_unavailable' }), { status: 503 }) });
  await mount();
  const button = await screen.findByRole('button', { name: english.automation.builtinBrowser.open }) as HTMLButtonElement;

  fireEvent.click(button);
  await waitFor(() => assert.equal(screen.getByRole('status').textContent, english.automation.builtinBrowser.errors.unavailable));
  assert.deepEqual(calls.filter((call) => call.path.startsWith('/api/browser/')), [
    { path: '/api/browser/session%2Fa/open', method: 'POST', body: {} },
  ]);
  assert.equal(externalOpens, 0);
});

test('desktop launch falls back to the selected project scope when no app session was selected', async () => {
  const calls = fakeApi();
  useAppShellStore.setState({ selectedProject: project, selectedSession: null });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: english.automation.builtinBrowser.open }));
  await waitFor(() => assert.equal(screen.getByRole('status').textContent, english.automation.builtinBrowser.opened));
  assert.equal(calls.some((call) => call.path === '/api/browser/project-project-a/open'), true);
});

test('switching and deselecting sessions changes Settings launch ownership immediately', async () => {
  const calls = fakeApi();
  useAppShellStore.setState({ selectedProject: project, selectedSession: { id: 'session-a' } });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  await mount();
  const button = await screen.findByRole('button', { name: english.automation.builtinBrowser.open });

  fireEvent.click(button);
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/browser/session-a/open')));
  act(() => useAppShellStore.setState({ selectedSession: { id: 'session-b' } }));
  fireEvent.click(button);
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/browser/session-b/open')));
  act(() => useAppShellStore.setState({ selectedSession: null }));
  fireEvent.click(button);
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/browser/project-project-a/open')));
});

test('manual built-in launch is independent of the selected agent backend', async () => {
  const calls = fakeApi();
  useAppShellStore.setState({ selectedProject: project, selectedSession: null });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  await mount();
  await waitFor(() => assert.equal(backendSelect().disabled, false));

  fireEvent.change(backendSelect(), { target: { value: 'ego' } });
  await waitFor(() => assert.equal(backendSelect().value, 'ego'));
  fireEvent.click(await screen.findByRole('button', { name: english.automation.builtinBrowser.open }));
  await waitFor(() => assert.equal(screen.getByRole('status').textContent, english.automation.builtinBrowser.opened));
  assert.deepEqual(calls.filter((call) => call.path.startsWith('/api/browser/')), [
    { path: '/api/browser/project-project-a/open', method: 'POST', body: {} },
  ]);
});

test('desktop bridge keeps launch disabled until the app server reports browser readiness', async () => {
  const calls = fakeApi({ browserReady: false });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  await mount();
  const button = await screen.findByRole('button', { name: english.automation.builtinBrowser.open }) as HTMLButtonElement;
  await waitFor(() => assert.equal(button.disabled, true));

  fireEvent.click(button);
  assert.equal(calls.some((call) => call.path.startsWith('/api/browser/')), false);
});

test('pairing shows an open-in-companion link, the ready-to-run command, and copy token/command buttons', async () => {
  const writeTextCalls: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { writeTextCalls.push(value); } }, configurable: true });
  fakeApi();
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: 'Pair this computer' }));
  const command = await screen.findByText(/--pair=fake-pairing-token/u);
  assert.ok(command.textContent?.startsWith('./gajae-agent-desktop-companion --server='));
  assert.ok(screen.getByRole('link', { name: /Open in companion/u }));

  fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
  await waitFor(() => assert.equal(writeTextCalls.length, 1));
  assert.equal(writeTextCalls[0], 'fake-pairing-token');
  assert.ok(screen.getByRole('button', { name: 'Token copied' }));

  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  await waitFor(() => assert.equal(writeTextCalls.length, 2));
  assert.ok(writeTextCalls[1].includes('--pair=fake-pairing-token'));
  assert.ok(screen.getByRole('button', { name: 'Command copied' }));
});

test('browser routing wording keys have parity across all ten settings locales', () => {
  function leaves(value: unknown, path = ''): Record<string, string> {
    if (typeof value === 'string') return { [path]: value };
    assert.ok(value && typeof value === 'object');
    return Object.assign({}, ...Object.entries(value).map(([key, item]) => leaves(item, `${path}.${key}`)));
  }

  const expected = leaves({ browserBackend: english.automation.browserBackend, builtinBrowser: english.automation.builtinBrowser });
  for (const locale of ['en', 'ko', 'de', 'fr', 'it', 'ja', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
    const file = new URL(`../../../../i18n/locales/${locale}/settings.json`, import.meta.url);
    const translated = JSON.parse(readFileSync(file, 'utf8')) as { automation?: unknown };
    const actual = leaves({
      browserBackend: (translated.automation as { browserBackend?: unknown } | undefined)?.browserBackend,
      builtinBrowser: (translated.automation as { builtinBrowser?: unknown } | undefined)?.builtinBrowser,
    });
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), locale);
    for (const [key, text] of Object.entries(actual)) assert.ok(text.trim().length > 0, `${locale}${key}`);
  }
});

/*
 * An app session takes the user's own tool and MCP settings, as the GJC CLI
 * does, so there is no list of runtime features the app switches off.
 */
test('no withheld runtime features are reported, because none are overridden', async () => {
  fakeApi();
  await mount();
  await waitFor(() => assert.equal(backendSelect().disabled, false));

  assert.equal(screen.queryByText('Withheld runtime features'), null);
  for (const locale of ['en', 'ko', 'de', 'fr', 'it', 'ja', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
    const file = new URL(`../../../../i18n/locales/${locale}/settings.json`, import.meta.url);
    const translated = JSON.parse(readFileSync(file, 'utf8')) as { automation?: Record<string, unknown> };
    assert.deepEqual(Object.keys(translated.automation ?? {}).filter((key) => key.startsWith('withheld')), [], locale);
  }
});

/*
 * Host control: reading Docker's facts and detecting what manages the host were
 * two switches over the same two daemon reads, so they are one switch here, and
 * the detection's answer - the OS - sits beside the button that fetches it.
 */
test('host reading is one switch, and detection sits left of it with the answer in the description slot', async () => {
  const calls = fakeApi({
    hostControl: {
      enabled: true,
      capabilities: { facts: false, discovery: false, containers: false, restart: false, docker: false, shell: false, files: false },
      host: null,
    },
  });
  await mount();
  const hostControl = english.automation.hostControl as Record<string, string>;

  const read = await screen.findByRole('switch', { name: hostControl.hostInfo! });
  assert.equal(read.getAttribute('aria-checked'), 'false');

  fireEvent.click(read);
  await waitFor(() => assert.equal(screen.getByRole('switch', { name: hostControl.hostInfo! }).getAttribute('aria-checked'), 'true'));
  assert.deepEqual(calls.filter((call) => call.path === '/api/host/settings').map((call) => call.body), [
    { facts: true, discovery: true },
  ]);
  // Switching the read on detects in the same save, so the answer is already
  // there - and the platform is named beside the OS, not just "Devuan".
  await screen.findByText('Devuan GNU/Linux 6 (excalibur) · MOS');

  const detect = screen.getByRole('button', { name: hostControl.detect! }) as HTMLButtonElement;
  const readSwitch = screen.getByRole('switch', { name: hostControl.hostInfo! });
  // Detect is part of the read row and comes before the switch it depends on.
  assert.equal(detect.compareDocumentPosition(readSwitch) & 4, 4, 'the detect button sits left of its switch');
  fireEvent.click(detect);
  await screen.findByText('Devuan GNU/Linux 6 (excalibur) · MOS');
  // Nothing else about the host is printed: the profile is the agent's, not the tab's.
  assert.equal(screen.queryByText('Webby'), null);
});

/*
 * The group row is the main one and is not indented; only its rows are, and
 * they are hidden while the group is off so the card stays one screen tall.
 */
test('the docker group hides its rows while it is off and sets all of them at once', async () => {
  const calls = fakeApi({
    hostControl: {
      enabled: true,
      capabilities: { facts: false, discovery: false, containers: false, restart: false, docker: false, shell: false, files: false },
      host: null,
    },
  });
  await mount();
  const hostControl = english.automation.hostControl as Record<string, string>;

  const group = await screen.findByRole('switch', { name: hostControl.dockerGroup! });
  assert.equal(group.getAttribute('aria-checked'), 'false');
  // Compare a boolean, not the element: formatting a mounted element walks the
  // React fiber tree, which is enough to exhaust the 5 s test timeout on a
  // loaded runner before the retry ever sees the rows go away.
  assert.equal(screen.queryByRole('switch', { name: hostControl.containers! }) === null, true, 'off means the group\'s rows are not shown');

  fireEvent.click(group);
  await waitFor(() => assert.ok(screen.getByRole('switch', { name: hostControl.containers! })));
  assert.deepEqual(calls.filter((call) => call.path === '/api/host/settings').map((call) => call.body), [
    { containers: true, restart: true, docker: true, shell: true, files: true },
  ]);

  fireEvent.click(screen.getByRole('switch', { name: hostControl.dockerGroup! }));
  await waitFor(() => assert.equal(screen.queryByRole('switch', { name: hostControl.containers! }) === null, true));
});

/*
 * The two halves of an SSH connection are two decisions: reading another
 * machine's host key must never rotate the client key pair, because every
 * machine already trusting the old public key would stop accepting it.
 */
test('the host key and the client key pair each have their own button and never replace each other', async () => {
  const calls = fakeApi({
    hostControl: {
      enabled: true,
      capabilities: { facts: false, discovery: false, containers: false, restart: false, docker: false, shell: false, files: false },
      host: null,
      ssh: { host: '192.168.1.10', port: 22, user: 'root', hostKey: '', keyPresent: false, writePreauthorized: false },
    },
  });
  await mount();
  const hostControl = english.automation.hostControl as Record<string, string>;

  const readHostKey = await screen.findByRole('button', { name: hostControl.sshHostKeyRead! });
  fireEvent.click(readHostKey);
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/host/ssh/host-key' && call.method === 'POST')));
  assert.equal(calls.some((call) => call.path === '/api/host/ssh/keys'), false, 'adding a machine must not replace the app key pair');
  await waitFor(() => assert.equal(
    (screen.getByRole('textbox', { name: hostControl.sshHostKey! }) as HTMLInputElement).value,
    'ssh-ed25519 AAAAscanned destination',
  ));

  fireEvent.click(screen.getByRole('button', { name: hostControl.sshGenerateKeyPair! }));
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/host/ssh/keys' && call.method === 'POST')));
  await waitFor(() => assert.equal(
    (screen.getByRole('textbox', { name: hostControl.sshPublicKey! }) as HTMLTextAreaElement).value,
    'ssh-ed25519 AAAAgenerated gajae-host-control',
  ));
  assert.equal(calls.filter((call) => call.path === '/api/host/ssh/host-key').length, 1, 'generating a pair never scans the destination');
  assert.ok(screen.getByText(hostControl.sshKeyPairReplaced!));
});

/* A saved detection is shown on load, without running one again. */
test('a stored detection renders its OS on load instead of waiting for the button', async () => {
  const calls = fakeApi({
    hostControl: {
      enabled: true,
      capabilities: { facts: true, discovery: true, containers: false, restart: false, docker: false, shell: false, files: false },
      host: { os: 'Debian GNU/Linux 12 (bookworm)', kernelVersion: '6.1.0-18-amd64', platform: null, detectedAt: 1 },
    },
  });
  await mount();

  assert.ok(await screen.findByText('Debian GNU/Linux 12 (bookworm)'));
  assert.equal(calls.some((call) => call.path === '/api/host/discovery'), false, 'opening Settings never runs a detection');
});
