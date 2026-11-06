import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, useTranslation } from 'react-i18next';

import enSidebar from '../../../i18n/locales/en/sidebar.json';
import { resetToasts, useToastStore } from '../../../stores/useToastStore';
import { useSidebarController } from '../hooks/useSidebarController';

/*
 * A worktree session's delete can be refused by the server for a real,
 * actionable reason (still running, or uncommitted changes in the
 * checkout) - see AppError codes SESSION_WORKTREE_RUNNING/_DIRTY in
 * server/services/session-worktree-paths.ts. The row only ever showed
 * the generic "Could not delete the conversation. Try again." toast,
 * discarding that message, which left a stuck worktree session
 * impossible to diagnose from the UI.
 */

// Stable identity across renders: the controller re-triggers effects keyed
// on this array, so a fresh literal per render spins forever.
const projects: never[] = [];

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); resetToasts(); globalThis.fetch = originalFetch; });

function installFetch(body: unknown, status = 409): void {
  globalThis.fetch = (async () => Response.json(body, { status })) as typeof globalThis.fetch;
}

function Harness() {
  const { t } = useTranslation(['sidebar']);
  return useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: () => {},
    onProjectSelect: () => {},
    onSessionSelect: () => {},
    setSidebarVisible: () => {},
    sidebarVisible: true,
  });
}

async function setup() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
    resources: { en: { sidebar: enSidebar } },
  });
  return renderHook(() => Harness(), {
    wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
  });
}

test("a refused worktree delete surfaces the server's real reason, not a generic message", async () => {
  installFetch({ error: { code: 'SESSION_WORKTREE_DIRTY', message: 'The worktree has uncommitted changes. Commit or discard them before deleting the session.' } });
  const { result } = await setup();

  act(() => { result.current.showDeleteSessionConfirmation(null, 'session-1', 'check current time'); });
  await act(async () => { await result.current.confirmDeleteSession(true); });

  await waitFor(() => assert.equal(useToastStore.getState().toasts.length, 1));
  const [toast] = useToastStore.getState().toasts;
  assert.equal(toast.tone, 'error');
  assert.equal(toast.message, 'The worktree has uncommitted changes. Commit or discard them before deleting the session.');
  assert.notEqual(toast.message, enSidebar.messages.deleteSessionFailed);
});

test('a refused worktree archive also surfaces the server\'s real reason', async () => {
  installFetch({ error: { code: 'SESSION_WORKTREE_RUNNING', message: 'The session is still running. Stop it before deleting it.' } });
  const { result } = await setup();

  await act(async () => { await result.current.archiveSession('session-1'); });

  await waitFor(() => assert.equal(useToastStore.getState().toasts.length, 1));
  assert.equal(useToastStore.getState().toasts[0].message, 'The session is still running. Stop it before deleting it.');
});

test('a malformed error body still falls back to the generic message', async () => {
  installFetch('not json', 500);
  const { result } = await setup();

  act(() => { result.current.showDeleteSessionConfirmation(null, 'session-1', 'check current time'); });
  await act(async () => { await result.current.confirmDeleteSession(true); });

  await waitFor(() => assert.equal(useToastStore.getState().toasts.length, 1));
  assert.equal(useToastStore.getState().toasts[0].message, enSidebar.messages.deleteSessionFailed);
});
