import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '../../../i18n/config';
import { useQuickChatStore } from '../../../stores/useQuickChatStore';
import SidebarContent from '../view/SidebarContent';
import { makeSidebarT, sidebarContentPropsFixture } from '../view/SidebarContent.testFixture';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  useQuickChatStore.getState().clear();
  globalThis.fetch = originalFetch;
});

test('starting an ordinary conversation deletes the temporary one still on screen', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push(`${init.method ?? 'GET'} ${typeof input === 'string' ? input : input.toString()}`);
    return Response.json({ success: true, data: { sessionId: 'quick-1', action: 'deleted', deletedFromDisk: true } });
  }) as typeof globalThis.fetch;

  const t = await makeSidebarT();
  const base = sidebarContentPropsFixture(t);
  // A temporary chat whose first turn already created its session.
  useQuickChatStore.getState().start('project-alpha', 'session-running');
  useQuickChatStore.getState().attachSession('project-alpha', 'quick-1');
  assert.ok(useQuickChatStore.getState().quickChat, 'the temporary chat is armed before it is left');

  render(createElement(
    MemoryRouter,
    null,
    createElement(SidebarContent, { ...base, projectListProps: { ...base.projectListProps } }),
  ));

  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

  await waitFor(() => {
    assert.ok(
      requests.some((request) => request.includes('/api/providers/sessions/quick-1?force=true&discardWorktree=true')),
      `expected a hard delete of the temporary session with its worktree, saw ${JSON.stringify(requests)}`,
    );
  });
  assert.equal(useQuickChatStore.getState().quickChat, null, 'the chip does not outlive the conversation');
});
