import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import english from '../../../../i18n/locales/en/settings.json';

import McpSettingsTab from './McpSettingsTab';

type Call = { path: string; method: string; body?: Record<string, unknown> };

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function catalogEntry() {
  return {
    name: 'github',
    title: 'GitHub',
    description: 'Read repositories, issues and pull requests.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    package: { manager: 'npm', name: '@modelcontextprotocol/server-github' },
    env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, secret: true, description: 'A token.' }],
    source: 'bundled',
  };
}

function installedServer(overrides: Record<string, unknown> = {}) {
  return {
    name: 'context7',
    transport: 'stdio',
    scope: 'global',
    enabled: true,
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: {},
    envIsSet: {},
    headers: {},
    headersIsSet: {},
    pin: null,
    pinnable: true,
    packageName: '@upstash/context7-mcp',
    install: { version: '4.7.0', status: 'installed' },
    ...overrides,
  };
}

function fakeApi(seed: Array<Record<string, unknown>> = [], statusSeed: { inFlight: boolean } = { inFlight: false }) {
  const calls: Call[] = [];
  let installed = seed;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });

    if (path.startsWith('/api/mcp/servers/') && !path.includes('/pin') && method === 'PATCH') {
      const name = decodeURIComponent(path.split('/')[4] ?? '');
      installed = installed.map((server) => (server.name === name ? { ...server, ...(body ?? {}) } : server));
      return new Response(JSON.stringify({
        success: true,
        data: installed.find((server) => server.name === name),
      }));
    }
    if (path.startsWith('/api/mcp/servers/') && path.includes('/verify') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, data: { ok: true, toolCount: 3, tools: ['a', 'b', 'c'] } }));
    }
    if (path.startsWith('/api/mcp/servers/') && path.includes('/pin') && method === 'POST') {
      const name = decodeURIComponent(path.split('/')[4] ?? '');
      installed = installed.map((server) => (server.name === name ? { ...server, pin: body?.version ?? null } : server));
      return new Response(JSON.stringify({
        success: true,
        data: installed.find((server) => server.name === name),
      }));
    }
    if (path.startsWith('/api/mcp/servers?') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: installed }));
    }
    if (path === '/api/mcp/status') {
      return new Response(JSON.stringify({
        success: true,
        data: { provisioning: null, inFlight: statusSeed.inFlight, failed: [], ledger: {}, missingMounts: [] },
      }));
    }
    if (path.startsWith('/api/mcp/catalog')) {
      const entry = catalogEntry();
      return new Response(JSON.stringify({
        success: true,
        data: { entries: [entry], counts: { bundled: 1, overlay: 0, registry: 0 } },
      }));
    }
    if (path === '/api/mcp/servers' && method === 'POST') {
      installed = [{
        name: body?.name,
        transport: body?.transport,
        scope: 'global',
        enabled: true,
        command: body?.command,
        args: body?.args ?? [],
        env: {},
        envIsSet: {},
        headers: {},
        headersIsSet: {},
        pin: null,
        pinnable: true,
        packageName: '@modelcontextprotocol/server-github',
        install: null,
      }];
      return new Response(JSON.stringify({ success: true, data: installed[0] }), { status: 201 });
    }
    return new Response(JSON.stringify({ success: false, error: { message: `unexpected ${method} ${path}` } }), { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function mount() {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { settings: english } }, interpolation: { escapeValue: false } });
  const view = render(<I18nextProvider i18n={i18n}><McpSettingsTab /></I18nextProvider>);
  await act(async () => {});
  return view;
}

test('install does not require env first, then the new row asks for configuration with a masked focused field', async () => {
  const calls = fakeApi();
  await mount();

  const install = await screen.findByRole('button', { name: english.mcp.install });
  assert.equal(document.querySelector('input[type="password"]'), null, 'the catalog card has no inline secret field');
  await act(async () => { fireEvent.click(install); });

  await waitFor(() => assert.equal(calls.filter((call) => call.method === 'POST').length, 1));
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post?.body?.env, undefined, 'install never blocks on or sends env');

  await screen.findByText(english.mcp.needsConfiguration);
  const block = screen.getByLabelText(`${english.mcp.configBlock} github`) as HTMLTextAreaElement;
  assert.ok(block, 'configure opens on the block for this server');
  await waitFor(() => assert.equal(document.activeElement, block, 'the block is focused'));
  assert.match(block.value, /GITHUB_PERSONAL_ACCESS_TOKEN: ""/u, 'the variable the catalog knows is in the block');
});

test('configure opens on the block the server runs and saves what that block says', async () => {
  const calls = fakeApi([installedServer({
    args: ['-y', '@modelcontextprotocol/server-github'],
    packageName: '@modelcontextprotocol/server-github',
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '***' },
    envIsSet: { GITHUB_PERSONAL_ACCESS_TOKEN: true },
  })]);
  await mount();
  // The catalog request has to land before the block can be topped up from it.
  await screen.findByText('GitHub');

  fireEvent.click(await screen.findByRole('button', { name: english.mcp.configure }));

  const block = screen.getByLabelText(`${english.mcp.configBlock} context7`) as HTMLTextAreaElement;
  assert.match(block.value, /^context7:\n {2}type: stdio\n {2}command: npx\n {2}args:\n/u);
  assert.match(block.value, /@modelcontextprotocol\/server-github/u);
  assert.match(block.value, /GITHUB_PERSONAL_ACCESS_TOKEN: "\*\*\*"/u, 'the stored value is shown instead of a blank');

  fireEvent.change(block, {
    target: {
      value: [
        'context7:',
        '  type: stdio',
        '  command: npx',
        '  args:',
        '    - "-y"',
        '    - "@upstash/context7-mcp"',
        '  env:',
        '    CONTEXT7_API_KEY: "ctx_new"',
      ].join('\n'),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: english.mcp.save }));

  await waitFor(() => {
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(patch?.body?.env, { CONTEXT7_API_KEY: 'ctx_new' });
    assert.deepEqual(patch?.body?.args, ['-y', '@upstash/context7-mcp']);
  });
});

test('save stays disabled while the block has nothing to run', async () => {
  fakeApi([installedServer()]);
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: english.mcp.configure }));
  assert.equal((screen.getByRole('button', { name: english.mcp.save }) as HTMLButtonElement).disabled, false);

  fireEvent.change(screen.getByLabelText(`${english.mcp.configBlock} context7`), {
    target: { value: 'context7:\n  type: stdio\n  command: ""\n' },
  });
  assert.equal((screen.getByRole('button', { name: english.mcp.save }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText(english.mcp.blockInvalid), 'the block says why it cannot be used');
});

test('the catalog leaves configured servers out instead of listing them twice', async () => {
  fakeApi([installedServer({ name: 'github', packageName: '@modelcontextprotocol/server-github' })]);
  await mount();

  await screen.findByText(english.mcp.allInstalled);
  const removeButtons = screen.getAllByRole('button', { name: english.mcp.remove });
  assert.equal(removeButtons.length, 1, 'only the installed list carries the server');

  fireEvent.click(removeButtons[0]);
  assert.equal(screen.getAllByRole('button', { name: english.mcp.confirmRemove }).length, 1);
});

test('saving a configuration drops the handshake result from the old one', async () => {
  fakeApi([installedServer()]);
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: english.mcp.verify }));
  await screen.findByText(new RegExp(english.mcp.verifiedTools.replace('{{count}}', '3').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));

  fireEvent.click(screen.getByRole('button', { name: english.mcp.configure }));
  fireEvent.change(screen.getByLabelText(`${english.mcp.configBlock} context7`), {
    target: { value: 'context7:\n  type: stdio\n  command: node\n  args:\n    - server.js\n' },
  });
  fireEvent.click(screen.getByRole('button', { name: english.mcp.save }));

  await waitFor(() => {
    assert.equal(screen.queryByText(/3 tools/u), null, 'the old result no longer describes this server');
  });
});

test('the status chip stops saying running once provisioning finishes', async () => {
  const statusSeed = { inFlight: true };
  fakeApi([installedServer()], statusSeed);
  await mount();

  await screen.findByText(english.mcp.statusRunning);
  statusSeed.inFlight = false;
  await waitFor(() => assert.ok(screen.getByText(english.mcp.statusIdle)), { timeout: 9000 });
});

test('the sort control stays put while the search box is used', async () => {
  const calls = fakeApi();
  await mount();
  assert.ok(screen.getByLabelText(english.mcp.sort));

  const search = screen.getByPlaceholderText(english.mcp.searchPlaceholder);
  await act(async () => { fireEvent.change(search, { target: { value: 'git' } }); });

  assert.ok(screen.getByLabelText(english.mcp.sort), 'typing must not unmount the sort control');
  await waitFor(() => assert.ok(
    calls.some((call) => call.path.includes('q=git') && call.path.includes('sort=relevance')),
    'the search request carries the chosen sort',
  ));
});

test('project scope refuses to install until a project is selected', async () => {
  const calls = fakeApi();
  await mount();

  const scope = screen.getByLabelText(english.mcp.scope);
  await act(async () => { fireEvent.change(scope, { target: { value: 'project' } }); });
  await waitFor(() => assert.ok(calls.some((call) => call.path === '/api/projects?summary=1')));

  const install = await screen.findByRole('button', { name: english.mcp.install });
  assert.equal((install as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText(english.mcp.projectRequired));
});

test('a server version is text until clicked, and confirming a typed version pins it', async () => {
  const calls = fakeApi([installedServer()]);
  await mount();

  const versionButton = await screen.findByRole('button', { name: `${english.mcp.version} context7: 4.7.0` });
  assert.match(versionButton.textContent ?? '', /4\.7\.0/u);
  assert.equal(screen.queryByRole('textbox', { name: `${english.mcp.version} context7` }), null);

  fireEvent.click(versionButton);

  const input = screen.getByRole('textbox', { name: `${english.mcp.version} context7` }) as HTMLInputElement;
  assert.equal(input.value, '4.7.0');
  fireEvent.change(input, { target: { value: '4.6.0' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  await waitFor(() => {
    const pin = calls.find((call) => call.method === 'POST' && call.path.includes('/pin'));
    assert.deepEqual(pin?.body, { version: '4.6.0' });
  });
  await screen.findByRole('button', { name: `${english.mcp.unpin} context7` });
});

test('the pin button locks the version the server is running', async () => {
  const calls = fakeApi([installedServer()]);
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: `${english.mcp.pin} context7` }));

  await waitFor(() => {
    const pin = calls.find((call) => call.method === 'POST' && call.path.includes('/pin'));
    assert.deepEqual(pin?.body, { version: '4.7.0' });
  });
  await screen.findByRole('button', { name: `${english.mcp.unpin} context7` });
});

test('a pinned server unpins with the same button', async () => {
  const calls = fakeApi([installedServer({ pin: '4.7.0' })]);
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: `${english.mcp.unpin} context7` }));

  await waitFor(() => {
    const pin = calls.find((call) => call.method === 'POST' && call.path.includes('/pin'));
    assert.deepEqual(pin?.body, { version: null });
  });
  await screen.findByRole('button', { name: `${english.mcp.pin} context7` });
});

test('escape leaves the version alone', async () => {
  const calls = fakeApi([installedServer()]);
  await mount();

  fireEvent.click(await screen.findByRole('button', { name: `${english.mcp.version} context7: 4.7.0` }));
  const input = screen.getByRole('textbox', { name: `${english.mcp.version} context7` });
  fireEvent.change(input, { target: { value: '9.9.9' } });
  fireEvent.keyDown(input, { key: 'Escape' });

  await waitFor(() => assert.equal(screen.queryByRole('textbox', { name: `${english.mcp.version} context7` }), null));
  assert.equal(calls.some((call) => call.path.includes('/pin')), false);
});

// The switch used to be the last thing added to the button cluster, so rows
// with pin controls carried it further left than rows without and the toggles
// never lined up. It now leads the row, at the same x for every server.
test('every row opens with its switch instead of ending with it', async () => {
  fakeApi([
    installedServer(),
    installedServer({
      name: 'home-assistant',
      transport: 'http',
      url: 'http://192.168.1.9:9583/api/mcp',
      command: undefined,
      args: undefined,
      pinnable: false,
      packageName: null,
      install: null,
    }),
  ]);
  await mount();

  const switches = await screen.findAllByRole('switch');
  assert.equal(switches.length, 2);
  for (const control of switches) {
    assert.equal(control.parentElement?.firstElementChild, control, 'the switch is the first control in its row');
  }
  // The button cluster is what used to carry the switch, at whichever x the
  // row's controls happened to end.
  const bars = screen.getAllByRole('button', { name: english.mcp.verify }).map((button) => button.parentElement);
  assert.equal(bars.length, 2);
  for (const bar of bars) assert.equal(bar?.querySelector('[role="switch"]'), null, 'the buttons no longer hold the switch');
});

// A remote row has no pin controls, so a remove button flowing after Configure
// sat in a different column than on a package row. It is anchored right, which
// keeps every row's bar the same shape however many servers are listed and
// whatever transport each one uses.
test('every row keeps the same action bar, with remove anchored to the right edge', async () => {
  fakeApi([
    installedServer(),
    installedServer({
      name: 'home-assistant',
      transport: 'http',
      url: 'http://192.168.1.9:9583/api/mcp',
      command: undefined,
      args: undefined,
      pinnable: false,
      packageName: null,
      install: null,
    }),
  ]);
  await mount();

  const verifies = await screen.findAllByRole('button', { name: english.mcp.verify });
  assert.equal(verifies.length, 2);
  const bars = verifies.map((button) => button.parentElement);
  for (const bar of bars) {
    assert.ok(bar?.className.includes('w-full'), 'the bar is its own full-width line on every row');
    // The per-server scope control leads the bar on every row; the pin
    // controls a package row adds sit after it, so the bar's start is fixed.
    assert.equal(bar?.firstElementChild?.tagName, 'SELECT', 'every bar starts with the scope control');
    assert.ok(
      (bar?.firstElementChild?.getAttribute('aria-label') ?? '').startsWith(`${english.mcp.scope} `),
      'the leading control is the server scope',
    );
    const remove = bar?.lastElementChild as HTMLElement | null;
    assert.ok(remove?.className.includes('ml-auto'), 'the remove control is pushed to the right edge');
    assert.equal(remove?.textContent, english.mcp.remove);
  }
  // Only a row with a package version to lock carries the pin controls; the
  // anchored remove means that gap does not move anything else.
  assert.equal(bars[1]?.querySelector(`[aria-label^="${english.mcp.pin}"]`), null);
});
