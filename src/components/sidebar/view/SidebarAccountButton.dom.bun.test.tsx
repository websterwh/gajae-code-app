/**
 * The account control exists to answer "who am I signed in as?" without a trip
 * to Settings, so the popover has to name the account and carry the sign-out
 * action itself.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance, type TFunction } from 'i18next';
import { createElement } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import english from '../../../i18n/locales/en/sidebar.json';

import SidebarAccountButton from './SidebarAccountButton';

const originalFetch = globalThis.fetch;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['sidebar'],
  defaultNS: 'sidebar',
  resources: { en: { sidebar: english } },
  interpolation: { escapeValue: false },
});
const t = i18n.getFixedT(null, 'sidebar') as unknown as TFunction;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubAccount() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/oidc/status')) {
      return new Response(JSON.stringify({
        data: { configured: true, localAccess: false, loginUrl: '/api/auth/oidc/start' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/auth/oidc/session')) {
      return new Response(JSON.stringify({
        data: { email: 'ada@example.com', name: 'Ada Lovelace' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
}

const renderButton = () => render(
  createElement(I18nextProvider, { i18n }, createElement(SidebarAccountButton, { t })),
);

test('the signed-in control names the account and offers sign-out', async () => {
  stubAccount();
  const view = renderButton();

  const trigger = await waitFor(() => screen.getByRole('button', { name: /ada@example\.com/u }));
  assert.equal(view.container.querySelector('[role="menu"]'), null, 'the popover starts closed');

  fireEvent.click(trigger);

  const menu = screen.getByRole('menu');
  assert.match(menu.textContent ?? '', /Ada Lovelace/u);
  assert.match(menu.textContent ?? '', /ada@example\.com/u);

  const signOut = screen.getByRole('menuitem', { name: /sign out/iu });
  assert.match(signOut.className, /text-destructive/u, 'sign-out reads as destructive');
  assert.equal(signOut.hasAttribute('disabled'), false);
});

test('a signed-out deployment offers sign-in instead of a menu', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/oidc/status')) {
      return new Response(JSON.stringify({
        data: { configured: true, localAccess: false, loginUrl: '/api/auth/oidc/start' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 401 });
  }) as typeof globalThis.fetch;

  renderButton();

  const signIn = await waitFor(() => screen.getByRole('link', { name: 'Sign in' }));
  assert.equal(signIn.getAttribute('href'), '/api/auth/oidc/start');
  assert.equal(screen.queryByRole('menu'), null);
});
