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

function fakeApi() {
  const calls: Call[] = [];
  let installed: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });

    if (path.startsWith('/api/mcp/servers?') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: installed }));
    }
    if (path === '/api/mcp/status') {
      return new Response(JSON.stringify({
        success: true,
        data: { provisioning: null, inFlight: false, failed: [], ledger: {}, missingMounts: [] },
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
  const secret = document.querySelector('input[type="password"]') as HTMLInputElement | null;
  assert.ok(secret, 'configure opens with the required secret field');
  await waitFor(() => assert.equal(document.activeElement, secret, 'the required field is focused'));
  assert.ok(screen.getByText(/GITHUB_PERSONAL_ACCESS_TOKEN/u));
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
