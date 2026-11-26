import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { useSessionStore, type FetchMoreResult, type NormalizedMessage, type SessionSlot, type SessionStore } from '../../../stores/useSessionStore';
import type { Project, ProjectSession } from '../../../types/app';
import { cacheContextFacts, readCachedContextFacts } from '../utils/contextSnapshotCache';

import { LOAD_ALL_LIMIT, useChatSessionState } from './useChatSessionState';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const project = { projectId: 'project', fullPath: '/repo', displayName: 'Repo' } as Project;
const empty: NormalizedMessage[] = [];
const noop = () => {};
const page = (total: number, hasMore = false): SessionSlot => ({
  total, hasMore, tokenUsage: { used: total }, serverMessages: [{ id: `m-${total}` }],
}) as SessionSlot;

function mount() {
  const pending: Array<{ id: string; resolve: (slot: SessionSlot) => void }> = [];
  const usage: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => { usage.push({ url, resolve }); })) as typeof fetch;
  const fetchPage = (id: string) => new Promise<SessionSlot>((resolve) => { pending.push({ id, resolve }); });
  const store = {
    getMessages: () => empty,
    has: () => true,
    isStale: () => false,
    setActiveSession: noop,
    fetchFromServer: fetchPage,
    fetchMore: fetchPage,
  } as unknown as SessionStore;
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const view = renderHook(({ id }: { id: string | null }) => useChatSessionState({
    selectedProject: project,
    selectedSession: id ? { id } as ProjectSession : null,
    ws: null, sendMessage: noop, resetStreamingState: noop,
    sessionStore: store, statusCheckSentAtRef,
  }), { initialProps: { id: 'a' as string | null } });
  const resolvePage = async (index: number, slot: SessionSlot) => {
    await act(async () => { pending.splice(index, 1)[0].resolve(slot); });
  };
  return { ...view, pending, usage, resolvePage };
}

test('a late initial history response cannot replace the next session pagination or budget', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(2));
  await view.resolvePage(0, page(100, true));
  assert.equal(view.result.current.totalMessages, 2);
  assert.equal(view.result.current.hasMoreMessages, false);
  assert.deepEqual(view.result.current.tokenBudget, { used: 2 });
});

test('the loading indicator belongs to the pending session, not an old response', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await view.resolvePage(0, page(100, true));
  assert.equal(view.result.current.isLoadingSessionMessages, true);
  await view.resolvePage(0, page(2));
  assert.equal(view.result.current.isLoadingSessionMessages, false);
});

test('late token usage success and failure cannot update another session', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await act(async () => { view.usage[1].resolve(new Response(JSON.stringify({ used: 2 }))); });
  await act(async () => { view.usage[0].resolve(new Response(JSON.stringify({ used: 100 }))); });
  assert.deepEqual(view.result.current.tokenBudget, { used: 2 });

  view.rerender({ id: 'c' });
  view.rerender({ id: 'd' });
  await act(async () => { view.usage[3].resolve(new Response(JSON.stringify({ used: 4 }))); });
  await act(async () => { view.usage[2].resolve(new Response('{}', { status: 404 })); });
  assert.deepEqual(view.result.current.tokenBudget, { used: 4 });
});

// The sidebar re-set the same project from its cache on every session upsert.
// That is a new record with the same id, and the usage effect used to treat it
// as a new scope: one request per upsert, and each failure cleared the facts
// the websocket had just delivered.
test('reconciling the project record does not re-request usage or drop reported facts', async () => {
  const requests: string[] = [];
  globalThis.fetch = ((url: string) => {
    requests.push(String(url));
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const store = {
    getMessages: () => empty,
    has: () => true,
    isStale: () => false,
    setActiveSession: noop,
    fetchFromServer: () => Promise.resolve({ total: 0, hasMore: false, serverMessages: [], tokenUsage: null } as unknown as SessionSlot),
    fetchMore: () => Promise.resolve(null),
  } as unknown as SessionStore;
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const view = renderHook(({ projectRecord }: { projectRecord: Project }) => useChatSessionState({
    selectedProject: projectRecord,
    selectedSession: { id: 'a' } as ProjectSession,
    ws: null, sendMessage: noop, resetStreamingState: noop,
    sessionStore: store, statusCheckSentAtRef,
  }), { initialProps: { projectRecord: project } });

  assert.equal(requests.length, 1, 'one usage request for the session');
  act(() => { view.result.current.setSessionState({ contextPercent: 42, contextWindow: 128_000 }); });
  await act(async () => { view.rerender({ projectRecord: { ...project } }); });

  assert.equal(requests.length, 1, 'a reconciled project record is not a new usage scope');
  assert.equal(view.result.current.sessionState?.contextPercent, 42);
});

test('a failed token usage request keeps the facts the websocket already delivered', async () => {
  const view = mount();
  act(() => {
    view.result.current.setSessionState({ contextPercent: 42, contextWindow: 128_000 });
    view.result.current.setTokenBudget({ used: 7 });
  });
  // The endpoint answers 404 until the session is indexed, well after the
  // runtime has already reported the same figures over the websocket.
  await act(async () => { view.usage[0].resolve(new Response('{}', { status: 404 })); });
  assert.equal(view.result.current.sessionState?.contextPercent, 42);
  assert.deepEqual(view.result.current.tokenBudget, { used: 7 });
});

test('an old load-all response cannot finish a new load-all request after switching away and back', async () => {
  const view = mount();
  await view.resolvePage(0, page(20, true));
  let first: Promise<void>;
  act(() => { first = view.result.current.loadAllMessages(); });
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(2));
  view.rerender({ id: 'a' });
  await view.resolvePage(1, page(20, true));
  let second: Promise<void>;
  act(() => { second = view.result.current.loadAllMessages(); });
  await view.resolvePage(0, page(100));
  await first!;
  assert.equal(view.result.current.isLoadingAllMessages, true);
  assert.equal(view.result.current.allMessagesLoaded, false);
  assert.equal(view.result.current.totalMessages, 20);
  await view.resolvePage(0, page(101));
  await second!;
  assert.equal(view.result.current.totalMessages, 101);
});

test('an old pagination request cannot change a new session or block its own pagination', async () => {
  const view = mount();
  await view.resolvePage(0, page(100, true));
  view.result.current.scrollContainerRef.current = document.createElement('div');
  let first: Promise<void>;
  act(() => { first = view.result.current.handleScroll(); });
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(50, true));
  let second: Promise<void>;
  act(() => { second = view.result.current.handleScroll(); });
  assert.deepEqual(view.pending.map(({ id }) => id), ['a', 'b']);
  await view.resolvePage(0, page(100));
  await first!;
  assert.equal(view.result.current.isLoadingMoreMessages, true);
  assert.equal(view.result.current.totalMessages, 50);
  await view.resolvePage(0, page(50));
  await second!;
  assert.equal(view.result.current.hasMoreMessages, false);
});

test('subscription cursors survive A → B → A, reconnect, and remount with the shared store', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [], total: 0, hasMore: false }))) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shared = renderHook(useSessionStore, {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  const store = shared.result.current;
  store.trackReplayFrame('a', { seq: 80, replayGeneration: 'a-first' });
  store.trackReplayFrame('b', { seq: 3, replayGeneration: 'b-first' });
  const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const mountSubscriber = () => renderHook(({ id, socket }) => useChatSessionState({
    selectedProject: project, selectedSession: { id } as ProjectSession, ws: socket,
    sendMessage, resetStreamingState: noop, sessionStore: store, statusCheckSentAtRef,
  }), { initialProps: { id: 'a', socket: {} as WebSocket } });
  const expectCursor = (sessionId: string, replayGeneration: string, lastSeq: number) => {
    assert.deepEqual(sent.at(-1), { type: 'chat.subscribe', sessions: [{ sessionId, replayGeneration, lastSeq }] });
  };
  const view = mountSubscriber();
  await act(async () => {});
  expectCursor('a', 'a-first', 80);
  view.rerender({ id: 'b', socket: {} as WebSocket });
  await act(async () => {});
  expectCursor('b', 'b-first', 3);
  store.trackReplayFrame('a', { kind: 'chat_subscribed', replayGeneration: 'a-next' });
  store.trackReplayFrame('a', { seq: 1, replayGeneration: 'a-next' });
  view.rerender({ id: 'a', socket: {} as WebSocket });
  await act(async () => {});
  expectCursor('a', 'a-next', 1);
  sent.length = 0;
  view.rerender({ id: 'a', socket: {} as WebSocket });
  expectCursor('a', 'a-next', 1);
  view.unmount();
  mountSubscriber();
  await act(async () => {});
  expectCursor('a', 'a-next', 1);
  assert.deepEqual(store.getReplayCursor('b'), { replayGeneration: 'b-first', lastSeq: 3 });
});

test('opening a conversation restores the context facts it last reported', async () => {
  // The Agent sidebar reads these through the published status snapshot; the
  // runtime only sends them with a run, so a reopened conversation used to
  // have no Context row until the next message.
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    configurable: true,
  });
  cacheContextFacts('a', { contextPercent: 42, contextWindow: 128_000, contextTokens: 53_760 });
  cacheContextFacts('b', { contextPercent: 7, contextWindow: 200_000 });
  globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [], total: 0, hasMore: false }))) as typeof fetch;
  const sessionStore = {
    getMessages: () => empty,
    has: () => true,
    isStale: () => false,
    setActiveSession: noop,
    fetchFromServer: () => Promise.resolve({ total: 0, hasMore: false, serverMessages: [], tokenUsage: null } as unknown as SessionSlot),
    fetchMore: () => Promise.resolve(null),
  } as unknown as SessionStore;
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const view = renderHook(({ id }: { id: string | null }) => useChatSessionState({
    selectedProject: project,
    selectedSession: id ? { id } as ProjectSession : null,
    ws: null, sendMessage: noop, resetStreamingState: noop,
    sessionStore, statusCheckSentAtRef,
  }), { initialProps: { id: null as string | null } });
  // The pane is mounted before a conversation is picked, which is the ordinary
  // path: landing, then a click in the sidebar.
  await act(async () => {});
  view.rerender({ id: 'a' });
  await act(async () => {});

  assert.equal(view.result.current.sessionState?.contextPercent, 42, 'the session shows its own reported context on open');
  assert.equal(view.result.current.sessionState?.contextWindow, 128_000);
  assert.equal(view.result.current.sessionState?.contextTokens, 53_760);

  assert.deepEqual(readCachedContextFacts('b'), { contextWindow: 200_000, contextPercent: 7 }, 'the second session is cached');
  view.rerender({ id: 'b' });
  await act(async () => {});
  assert.equal(view.result.current.sessionState?.contextPercent, 7, 'another conversation gets its own facts, never the previous ones');
  assert.deepEqual(readCachedContextFacts('b'), { contextWindow: 200_000, contextPercent: 7 }, 'the switch does not file the old session facts under the new id');
});

const message = (id: string, seconds: number, content = id): NormalizedMessage => ({
  id, sessionId: 'session', timestamp: new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString(),
  provider: 'gjc', kind: 'text', role: 'assistant', content,
});

async function setup(options: { pane?: boolean; density?: 'compact' | 'balanced' | 'detailed' } = {}) {
  let pane = options.pane ?? true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  let rows = [message('first', 20), message('latest', 30)];
  let pageRequests = 0;
  let pageResolve: ((value: FetchMoreResult) => void) | undefined;
  let allResolve: ((value: unknown) => void) | undefined;
  let stale = false;
  let firstPageResolve: ((window: unknown) => void) | undefined;
  let state: ReturnType<typeof useChatSessionState> | undefined;
  const store = {
    setActiveSession() {},
    getMessages: () => rows,
    has: () => true,
    isStale: () => stale,
    fetchFromServer: (_id: string, options: { limit: number | null }) => options.limit === null || options.limit === LOAD_ALL_LIMIT
      ? new Promise(resolve => { allResolve = resolve; })
      : stale
        ? new Promise(resolve => { firstPageResolve = resolve; })
        : Promise.resolve({ serverMessages: rows, hasMore: true, total: 40 }),
    fetchMore: () => { pageRequests += 1; return new Promise(resolve => { pageResolve = resolve; }); },
  } as unknown as SessionStore;
  const props = {
    selectedProject: { projectId: 'project', displayName: 'Project', fullPath: '/project' },
    selectedSession: { id: 'session' }, ws: null, sendMessage() {}, resetStreamingState() {},
    statusCheckSentAtRef: { current: new Map<string, number>() },
    sessionStore: store,
    density: options.density,
  };
  function Harness() {
    state = useChatSessionState(props);
    // Production wiring: the pane publishes its node through the callback ref.
    return pane ? <div ref={state.attachScrollContainer}><div /></div> : null;
  }
  const view = render(<Harness />);
  await act(async () => {});
  act(() => state!.setIsUserScrolledUp(true));
  const update = (next: NormalizedMessage[]) => {
    rows = next;
    view.rerender(<Harness />);
  };
  return {
    state: () => state!,
    rows: () => rows,
    update,
    pageRequests: () => pageRequests,
    mountPane() {
      pane = true;
      act(() => { view.rerender(<Harness />); });
      const node = state!.scrollContainerRef.current;
      assert.ok(node, 'the attached pane is published to the session state');
      return node;
    },
    async page(next: NormalizedMessage[], beforeResolve?: () => void, hasMore = false) {
      let request: Promise<void>;
      act(() => { request = state!.handleScroll(); });
      assert.ok(pageResolve);
      beforeResolve?.();
      await act(async () => {
        const addedCount = next.length - rows.length;
        rows = next;
        pageResolve!({ failed: false, addedCount, hasMore, total: next.length });
        await request!;
      });
    },
    async pageOutcome(outcome: { failed: true } | null) {
      let request: Promise<void>;
      act(() => { request = state!.handleScroll(); });
      assert.ok(pageResolve);
      await act(async () => { pageResolve!(outcome); await request!; });
    },
    async retry(next: NormalizedMessage[]) {
      act(() => state!.retryOlderMessages());
      const addedCount = next.length - rows.length;
      rows = next;
      await act(async () => { pageResolve!({ failed: false, addedCount, hasMore: false, total: next.length }); });
    },
    async all(next: NormalizedMessage[] | null) {
      let request: Promise<void>;
      act(() => { request = state!.loadAllMessages(); });
      assert.ok(allResolve);
      await act(async () => {
        if (next) rows = next;
        allResolve!(next ? { serverMessages: rows, hasMore: false, total: rows.length } : null);
        await request!;
      });
    },
    async switchSession() {
      props.selectedSession = { id: 'another-session' };
      await act(async () => view.rerender(<Harness />));
    },
    setStale(value: boolean) { stale = value; },
    async resolveFirstPage(next: NormalizedMessage[] = rows, hasMore = true) {
      await act(async () => { firstPageResolve?.({ serverMessages: next, hasMore, total: 40 }); });
    },
    close() { view.unmount(); globalThis.fetch = originalFetch; },
  };
}

test('an empty page claiming more history stops automatic retries without hiding history', async () => {
  const harness = await setup();
  try {
    await harness.page(harness.rows(), undefined, true);
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.state().hasMoreMessages, true);
    assert.equal(harness.state().allMessagesLoaded, false);
    for (let index = 0; index < 8; index++) {
      await act(async () => { await harness.state().handleScroll(); });
    }
    assert.equal(harness.pageRequests(), 1);
    assert.equal(harness.state().isLoadingMoreMessages, false);
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.pageRequests(), 2);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.state().allMessagesLoaded, true);
  } finally { harness.close(); }
});

test('a superseded page stays quiet while a failed request raises the retry banner', async () => {
  const harness = await setup();
  try {
    // A reconcile after a live turn discards the in-flight page: not an error.
    await harness.pageOutcome(null);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.state().hasMoreMessages, true);
    await harness.pageOutcome({ failed: true });
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.pageRequests(), 2);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 2, 'a failed page is not retried automatically');
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.state().historyLoadError, false);
  } finally { harness.close(); }
});

test('a refused load-all surfaces the retry banner and the paged path still works', async () => {
  const harness = await setup();
  try {
    await harness.all(null);
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.state().allMessagesLoaded, false);
    assert.equal(harness.state().isLoadingAllMessages, false);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 0, 'no automatic paging behind an unresolved error');
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.pageRequests(), 1);
  } finally { harness.close(); }
});

test('the load-all pill follows the reader, not the transcript', async () => {
  const harness = await setup();
  try {
    assert.equal(harness.state().hasMoreMessages, true);
    assert.equal(harness.state().showLoadAllOverlay, true, 'scrolled up with unfetched history shows the pill');
    act(() => harness.state().setIsUserScrolledUp(false));
    assert.equal(harness.state().showLoadAllOverlay, false, 'following the tail hides the pill');
    act(() => harness.state().setIsUserScrolledUp(true));
    assert.equal(harness.state().showLoadAllOverlay, true);
    await harness.page(
      [message('older', 10), ...harness.rows()],
      () => {
        assert.equal(harness.state().isLoadingMoreMessages, true);
        assert.equal(harness.state().showLoadAllOverlay, false, 'the paged-loading spinner owns the top slot');
      },
      true,
    );
    assert.equal(harness.state().showLoadAllOverlay, true, 'idle at the top with history left shows the pill again');
    await harness.all([message('oldest', 0), ...harness.rows()]);
    assert.equal(harness.state().allMessagesLoaded, true);
    assert.equal(harness.state().showLoadAllOverlay, false, 'nothing left to load');
  } finally { harness.close(); }
});

test('reaching the top loads immediately without another leave-and-return gesture', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows()], () => {
      assert.equal(harness.state().isLoadingMoreMessages, true);
      assert.equal(harness.state().showLoadAllOverlay, false);
      act(() => { void harness.state().handleScroll(); });
      assert.equal(harness.pageRequests(), 1, 'repeated input cannot duplicate an in-flight request');
    }, true);
    assert.equal(harness.state().isLoadingMoreMessages, false);
    // Stay at scrollTop=0, as when a folded page adds no height or the user
    // keeps pulling upward. No detour below the old 100px lock boundary.
    await harness.page([message('oldest', 0), ...harness.rows()]);
    assert.equal(harness.pageRequests(), 2);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 2, 'end of history never sends another request');
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('reaching the top reveals already cached older rows without clicking a count notice', async () => {
  const harness = await setup();
  try {
    act(() => harness.update(Array.from({ length: 130 }, (_, index) => message(`row-${index}`, index))));
    assert.equal(harness.state().visibleMessages.length, 100);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.state().visibleMessages.length, 130);
    assert.equal(harness.pageRequests(), 0);
  } finally { harness.close(); }
});

test('loading an older page does not announce existing messages below as new', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows()]);
    assert.equal(harness.state().isUserScrolledUp, true);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('load-all does not announce historical messages as new', async () => {
  const harness = await setup();
  try {
    await harness.all([message('oldest', 0), message('older', 10), ...harness.rows()]);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('new tail arrival still announces while an older page is in flight', async () => {
  const harness = await setup();
  try {
    const arrived = message('arrived', 40);
    await harness.page([message('older', 10), ...harness.rows(), arrived], () => {
      act(() => harness.update([...harness.rows(), arrived]));
      assert.equal(harness.state().isLoadingMoreMessages, true);
      assert.equal(harness.state().hasNewMessagesBelow, true);
    });
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});

test('a genuine append in the same commit as prepend is announced', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows(), message('arrived', 40)]);
    assert.equal(harness.state().hasNewMessagesBelow, true);
    act(() => harness.state().scrollToBottomAndReset());
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('opening a session lands on its newest row even from a scrolled-up one', async () => {
  const harness = await setup();
  try {
    const pane = harness.state().scrollContainerRef.current!;
    let scrollTop = 0;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 900 });
    // The harness leaves the previous conversation scrolled up, as reading back
    // through a running session does. That flag belongs to the conversation it
    // was set in: switching must not let it cancel the open, which left the
    // reopened transcript parked while its backlog rendered above the newest row.
    await harness.switchSession();
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 120); }); });
    assert.equal(scrollTop, 900);
    assert.equal(harness.state().isLandingAtTail, false, 'the transcript is revealed once the landing settles');
  } finally { harness.close(); }
});

test('leaving the tail during an open reveals it and leaves jump-to-latest working', async () => {
  const harness = await setup();
  try {
    const pane = harness.state().scrollContainerRef.current!;
    let scrollTop = 900;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 900 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 400 });
    await harness.switchSession();
    assert.equal(harness.state().isLandingAtTail, true, 'the open starts behind the landing hold');

    // Reading back while the open is still holding paint ends the hold: a pane
    // that keeps following a hidden tail scrolls itself blank, and the button
    // beside it then reads as dead because there is nothing to look at.
    scrollTop = 150;
    await act(async () => {
      pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      await harness.state().handleScroll();
    });
    assert.equal(harness.state().isLandingAtTail, false, 'the transcript is revealed');
    assert.equal(harness.state().isUserScrolledUp, true, 'jump-to-latest is offered');

    act(() => harness.state().scrollToBottomAndReset());
    assert.equal(scrollTop, 900, 'the button lands on the newest row');
    assert.equal(harness.state().isUserScrolledUp, false, 'and following resumes');
  } finally {
    harness.close();
  }
});

test('a layout scroll during an open does not park the transcript at its top', async () => {
  const harness = await setup();
  try {
    const pane = harness.state().scrollContainerRef.current!;
    let scrollTop = 0;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 900 });
    await harness.switchSession();
    // A restored offset clamps to zero when the shorter first page replaces the
    // previous transcript. The browser raises a scroll event for it, but it is
    // layout, not the reader leaving the tail.
    await act(async () => { pane.dispatchEvent(new Event('scroll')); });
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 120); }); });
    assert.equal(scrollTop, 900, 'the open still lands on its newest row');
    assert.equal(harness.state().isLandingAtTail, false, 'and is revealed once it settles');
    assert.equal(harness.pageRequests(), 0, 'an open never pages through history on its own');
  } finally { harness.close(); }
});

test('arrivals that keep re-running the landing do not leave the open blank', async () => {
  const harness = await setup();
  // Frames are driven by hand: an arrival lands between each pair, which is how
  // a running turn re-runs the landing effect and replaces the frame it queued.
  const raf = globalThis.requestAnimationFrame;
  const cancelRaf = globalThis.cancelAnimationFrame;
  const queued = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { queued.set(++nextFrame, callback); return nextFrame; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frame: number) => { queued.delete(frame); }) as typeof cancelAnimationFrame;
  try {
    const pane = harness.state().scrollContainerRef.current!;
    let scrollTop = 0;
    let height = 900;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => height });
    await harness.switchSession();
    assert.equal(harness.state().isLandingAtTail, true, 'the open hides the backlog it lands past');
    for (let arrival = 0; arrival < 40 && harness.state().isLandingAtTail; arrival += 1) {
      height += 40;
      act(() => harness.update([...harness.rows(), message(`arrival-${arrival}`, 40)]));
      const frame = [...queued.values()];
      queued.clear();
      for (const callback of frame) act(() => { callback(performance.now()); });
    }
    assert.equal(harness.state().isLandingAtTail, false, 'the open reveals inside its frame budget');
    assert.equal(scrollTop, height, 'and it reveals already pinned to the newest row');
  } finally {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancelRaf;
    harness.close();
  }
});

test('an open waits for its own page instead of landing on the cached window', async () => {
  const harness = await setup();
  try {
    const pane = harness.state().scrollContainerRef.current!;
    let scrollTop = 0;
    let height = 900;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => height });
    // Seen a while ago: the store keeps the old window until the refetch lands.
    harness.setStale(true);
    await harness.switchSession();
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 120); }); });
    assert.equal(harness.state().isLandingAtTail, true, 'the cached window is not the open');
    height = 1800;
    await harness.resolveFirstPage();
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 120); }); });
    assert.equal(scrollTop, 1800, 'the page that arrived is what the open lands on');
    assert.equal(harness.state().isLandingAtTail, false);
  } finally { harness.close(); }
});

test('arrivals the density never renders do not announce unseen messages', async () => {
  const compact = await setup({ density: 'compact' });
  try {
    act(() => compact.update([...compact.rows(), { ...message('thoughts', 40), kind: 'thinking', content: 'weighing options' }]));
    assert.equal(compact.state().hasNewMessagesBelow, false, 'compact hides reasoning rows, so nothing new is on screen');
  } finally { compact.close(); }

  const detailed = await setup({ density: 'detailed' });
  try {
    act(() => detailed.update([...detailed.rows(), { ...message('thoughts', 40), kind: 'thinking', content: 'weighing options' }]));
    assert.equal(detailed.state().hasNewMessagesBelow, true, 'detailed renders the reasoning row it just received');
  } finally { detailed.close(); }
});

test('a pane attached after the landing view still binds the transcript scroll listener', async () => {
  // The chat interface is never remounted per session: until the first message
  // lands, the landing view owns the viewport and there is no pane to bind.
  const harness = await setup({ pane: false });
  try {
    const node = harness.mountPane();
    assert.equal(harness.pageRequests(), 0);
    // The landing owns the freshly attached pane until it settles; the reader's
    // own scrolling starts after that.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 120); }); });
    assert.equal(harness.state().isLandingAtTail, false);
    await act(async () => { node.dispatchEvent(new Event('scroll')); });
    assert.equal(harness.pageRequests(), 1);
  } finally { harness.close(); }
});

test('tail growth is announced without increasing the message count', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([harness.rows()[0], message('latest', 30, 'latest streaming addition')]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});

test('refreshing identical rows during history loading does not raise a badge', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows().map(row => ({ ...row }))]);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('returning to previously viewed content after rewind is not a new arrival', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().rewindMessages(1));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('a finalized stream with only a persisted ID change is not a new message', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().setIsUserScrolledUp(false));
    act(() => harness.update([harness.rows()[0], { ...message('stream', 30, 'answer'), kind: 'stream_delta' }]));
    act(() => harness.state().setIsUserScrolledUp(true));
    act(() => harness.update([harness.rows()[0], message('persisted', 35, 'answer')]));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('switching sessions clears an existing unread badge', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([...harness.rows(), message('new', 40)]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
    await harness.switchSession();
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('while following, new content does not create an unread badge', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().setIsUserScrolledUp(false));
    act(() => harness.update([...harness.rows(), message('new', 40)]));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('tail-window replacement notices a new message even with an unchanged count', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([harness.rows()[1], message('new', 40, 'x')]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});

test('opening a session does not set the store owner state during the child render', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [], total: 0, hasMore: false }))) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  let store: SessionStore | undefined;
  // Session rows are state in production; a fresh object per render would
  // re-run the history effect and hide the defect behind a different loop.
  const sessions: Record<string, ProjectSession> = { a: { id: 'a' } as ProjectSession, b: { id: 'b' } as ProjectSession };
  let renders = 0;
  function Child({ id }: { id: string }) {
    if (++renders > 30) throw new Error(`render loop (${renders})`);
    useChatSessionState({
      selectedProject: project, selectedSession: sessions[id], ws: null,
      sendMessage: noop, resetStreamingState: noop, sessionStore: store!, statusCheckSentAtRef,
    });
    return null;
  }
  // Production wiring: MainContent owns the store, ChatInterface consumes it.
  function Owner({ id }: { id: string }) {
    store = useSessionStore();
    return <Child id={id} />;
  }
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const view = render(<QueryClientProvider client={client}><Owner id="a" /></QueryClientProvider>);
    await act(async () => {});
    act(() => { view.rerender(<QueryClientProvider client={client}><Owner id="b" /></QueryClientProvider>); });
    await act(async () => {});
  } finally { console.error = originalError; }
  assert.deepEqual(errors.filter((line) => line.includes('Cannot update a component')), []);
});
