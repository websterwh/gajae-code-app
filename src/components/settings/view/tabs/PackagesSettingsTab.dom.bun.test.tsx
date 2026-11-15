import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import english from '../../../../i18n/locales/en/settings.json';

import PackagesSettingsTab from './PackagesSettingsTab';

type Call = { path: string; method: string; body?: Record<string, unknown> };
type Row = {
  manager: string;
  name: string;
  spec: string;
  pin: string | null;
  source: string;
  desired: boolean;
  status: string;
  version: string | null;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function row(pin: string | null = null): Row {
  return {
    manager: 'uv',
    name: 'serena',
    spec: 'git+https://github.com/oraios/serena',
    pin,
    source: 'ui',
    desired: true,
    status: 'installed',
    version: '2.1.1.dev0',
  };
}

function fakeApi() {
  const calls: Call[] = [];
  let current = row();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });

    if (path === '/api/packages' && method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: [current] }));
    }
    if (path === '/api/packages/uv/serena' && method === 'PATCH') {
      current = { ...current, pin: (body?.pin as string | null | undefined) ?? null };
      return new Response(JSON.stringify({ success: true, data: current }));
    }
    return new Response(JSON.stringify({ success: false, error: { message: `unexpected ${method} ${path}` } }), { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function renderTab() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    defaultNS: 'settings',
    resources: { en: { settings: english } },
    interpolation: { escapeValue: false },
  });
  render(<I18nextProvider i18n={i18n}><PackagesSettingsTab /></I18nextProvider>);
}

test('a package shows its version as text until it is clicked, and confirming a typed version pins it', async () => {
  const calls = fakeApi();
  await renderTab();

  const versionButton = await screen.findByRole('button', { name: /Version serena/ });
  assert.match(versionButton.textContent ?? '', /2\.1\.1\.dev0/);
  assert.equal(screen.queryByRole('textbox', { name: 'Version serena' }), null);

  fireEvent.click(versionButton);

  const input = screen.getByRole('textbox', { name: 'Version serena' }) as HTMLInputElement;
  assert.equal(input.value, '2.1.1.dev0');
  fireEvent.change(input, { target: { value: '2.0.0' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  await waitFor(() => {
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(patch?.body, { pin: '2.0.0' });
  });
  await screen.findByRole('button', { name: 'Unpin serena' });
});

test('the pin button locks the version that is installed', async () => {
  const calls = fakeApi();
  await renderTab();

  fireEvent.click(await screen.findByRole('button', { name: 'Pin serena' }));

  await waitFor(() => {
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(patch?.body, { pin: '2.1.1.dev0' });
  });
});

test('escape leaves the version alone', async () => {
  const calls = fakeApi();
  await renderTab();

  fireEvent.click(await screen.findByRole('button', { name: /Version serena/ }));
  const input = screen.getByRole('textbox', { name: 'Version serena' });
  fireEvent.change(input, { target: { value: '9.9.9' } });
  fireEvent.keyDown(input, { key: 'Escape' });

  await waitFor(() => {
    assert.equal(screen.queryByRole('textbox', { name: 'Version serena' }), null);
  });
  assert.equal(calls.some((call) => call.method === 'PATCH'), false);
});
