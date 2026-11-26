import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import { cacheContextFacts, readCachedContextFacts } from '../utils/contextSnapshotCache';
import { DEFAULT_TOOL_OUTPUT_DENSITY, toolOutputDensityRules } from '../utils/toolOutputDensity';
import type { ToolOutputDensity } from '../utils/toolOutputDensity';

import { normalizedToChatMessages } from './useChatMessages';
import { useChatFollowScroll } from './useChatFollowScroll';

const PAGE_SIZE = 20;
// The server refuses an unbounded history request once a transcript passes its
// record cap, so the "get all messages" paths ask for one bounded page. Older
// rows stay reachable through the paged scroll path.
export const LOAD_ALL_LIMIT = 1000;
const FIRST_VISIBLE_COUNT = 100;
const NO_MESSAGES: NormalizedMessage[] = [];

type Props = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
  showImagePreviews?: boolean;
  /** The transcript's reading level; the unread pill only counts rows it renders. */
  density?: ToolOutputDensity;
};

type SearchRequest = { timestamp?: string; uuid?: string; snippet?: string };

export function shouldRefreshCachedImageWindow(
  previousSessionKey: string | null,
  previousEnabled: boolean,
  nextSessionKey: string,
  nextEnabled: boolean,
  hasCachedSession: boolean,
): boolean {
  return hasCachedSession && nextEnabled && !previousEnabled && previousSessionKey === nextSessionKey;
}

function normalizeLocalMessage(message: ChatMessage, sessionId: string): NormalizedMessage {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = message.timestamp instanceof Date
    ? message.timestamp.toISOString()
    : typeof message.timestamp === 'number'
      ? new Date(message.timestamp).toISOString()
      : String(message.timestamp);
  const common = { id, sessionId, timestamp, provider: 'gjc' as LLMProvider };

  if (message.isToolUse) {
    return { ...common, kind: 'tool_use', toolName: message.toolName, toolInput: message.toolInput, toolId: message.toolId || id };
  }
  if (message.isThinking) return { ...common, kind: 'thinking', content: message.content || '' };
  if (message.isInteractivePrompt) return { ...common, kind: 'interactive_prompt', content: message.content || '' };
  if ((message as { isTaskNotification?: boolean }).isTaskNotification) {
    const task = message as ChatMessage & { taskStatus?: string };
    return { ...common, kind: 'task_notification', status: task.taskStatus || 'completed', summary: message.content || '' };
  }
  if (message.type === 'error') return { ...common, kind: 'error', content: message.content || '' };
  return {
    ...common,
    kind: 'text',
    role: message.type === 'user' ? 'user' : 'assistant',
    content: message.content || '',
    images: Array.isArray(message.images) && message.images.length ? message.images : undefined,
  };
}

function hasNewTailContent(previous: ChatMessage[], next: ChatMessage[]): boolean {
  const before = previous.at(-1);
  const after = next.at(-1);
  if (!before || !after) return false;
  const beforeKey = getIntrinsicMessageKey(before);
  const afterKey = getIntrinsicMessageKey(after);
  if (before === after || (beforeKey !== null && beforeKey === afterKey)) {
    return (after.content?.length ?? 0) > (before.content?.length ?? 0);
  }
  // Rewind/removal exposes a message we already had, not a new arrival.
  if (afterKey !== null && previous.some(message => getIntrinsicMessageKey(message) === afterKey)) return false;
  // Prepending history leaves the old tail last; appending puts a row after it.
  if (beforeKey !== null && next.some(message => getIntrinsicMessageKey(message) === beforeKey)) return true;
  // A refreshed window can replace IDs (notably a stream's persisted final row).
  // Equal final text is reconciliation, while a genuinely newer tail is an arrival.
  if (before.isStreaming && after.type === before.type && after.content === before.content) return false;
  return new Date(after.timestamp).getTime() > new Date(before.timestamp).getTime()
    || (Boolean(before.isStreaming) && after.type === before.type
      && Boolean(after.content?.startsWith(before.content ?? ''))
      && (after.content?.length ?? 0) > (before.content?.length ?? 0));
}

/**
 * Drops trailing rows the density never renders. Reasoning arrives as its own
 * message and compact and balanced hide those rows, so an arrival that is only
 * thoughts is nothing on screen - the pill must not claim a new message for it.
 */
function renderedTail(messages: ChatMessage[], showReasoning: boolean): ChatMessage[] {
  if (showReasoning) return messages;
  let end = messages.length;
  while (end > 0 && messages[end - 1].isThinking) end -= 1;
  return end === messages.length ? messages : messages.slice(0, end);
}

function clearTimer(timer: MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  newSessionTrigger,
  processingSessions,
  onSessionIdle: _onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  sessionStore,
  showImagePreviews = true,
  density = DEFAULT_TOOL_OUTPUT_DENSITY,
}: Props) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  // Which session's first page the hook has already received. Until then a
  // selected conversation is *opening*, not empty: the loading flag alone is
  // false on the render that switches sessions, which flashed "no messages"
  // between the opening spinner and the one the fetch starts.
  const [firstPageSessionKey, setFirstPageSessionKey] = useState<string | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  // The runtime reports context facts with a run and the chat drops them when
  // the session changes. A conversation opened later starts from the facts it
  // last reported, so the Agent sidebar's Context row is there before the next
  // message instead of appearing only after one.
  const [sessionState, setSessionState] = useState<Record<string, unknown> | null>(
    () => (selectedSession?.id ? readCachedContextFacts(selectedSession.id) : null),
  );
  const [visibleMessageCount, setVisibleMessageCount] = useState(FIRST_VISIBLE_COUNT);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const [searchTarget, setSearchTarget] = useState<SearchRequest | null>(null);
  // A conversation that kept running while it was closed replays the turns it
  // gained on open. Pinning to the newest row is right, but following each
  // arrival in view reads as scrolling through the whole missed backlog, so the
  // transcript stays hidden until the landing settles and is then revealed
  // already at the bottom.
  const [isLandingAtTail, setIsLandingAtTail] = useState(true);
  const landingAtTailRef = useRef(true);
  // The landing's frame budget belongs to the open, not to one run of the
  // effect below. That effect re-runs on every message-count change - a replay
  // burst, a live turn's thinking and tool rows - and per-run counters
  // restarted the countdown for each arrival: on a session opened while it was
  // running, the landing never settled, so the transcript stayed hidden (blank
  // but still taking layout) and pinned to a bottom that kept moving. It read
  // as a pane scrolling itself over empty space until a gesture revealed it.
  const landingProgressRef = useRef({ frames: 0, unchanged: 0, height: 0, armedAt: 0 });
  const endLandingAtTail = useCallback(() => {
    if (!landingAtTailRef.current) return;
    landingAtTailRef.current = false;
    setIsLandingAtTail(false);
  }, []);
  const beginLandingAtTail = useCallback(() => {
    if (landingAtTailRef.current) return;
    landingAtTailRef.current = true;
    landingProgressRef.current = { frames: 0, unchanged: 0, height: 0, armedAt: 0 };
    setIsLandingAtTail(true);
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The transcript pane is mounted and unmounted under the landing view while
  // this hook stays mounted, and the interface is never remounted per session.
  // Scroll behaviour therefore hangs off the attached node, not off a ref read
  // once at mount: the ref stays for synchronous reads, the state re-binds
  // listeners and observers every time the pane attaches.
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const attachScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainer(node);
  }, []);
  const activeSession = selectedSession?.id || currentSessionId || null;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  // Which session the state in hand was reported for. A render that has just
  // switched the selected session still holds the previous one's facts for a
  // frame; without this the cache would file them under the new session before
  // the restore below reads them back.
  const sessionStateOwnerRef = useRef<string | null>(selectedSession?.id ?? null);
  const applySessionState = useCallback((update: SetStateAction<Record<string, unknown> | null>) => {
    sessionStateOwnerRef.current = activeSessionRef.current;
    setSessionState(update);
  }, []);
  // Persist what the runtime reported while this session is on screen, keyed
  // by session so another conversation never inherits these numbers.
  useEffect(() => {
    const owner = sessionStateOwnerRef.current;
    if (owner && owner === activeSession && sessionState) cacheContextFacts(owner, sessionState);
  }, [activeSession, sessionState]);
  // A response belongs to one visit, including when the user returns to the
  // same session while an earlier visit still has requests in flight.
  const viewKey = `${selectedProject?.projectId ?? ''}:${activeSession ?? ''}:${newSessionTrigger ?? 0}`;
  const requestViewRef = useRef({ key: viewKey });
  if (requestViewRef.current.key !== viewKey) requestViewRef.current = { key: viewKey };
  const activityMapRef = useRef(processingSessions);
  activityMapRef.current = processingSessions;
  const pendingEchoRef = useRef<ChatMessage | null>(null);
  const messageLengthRef = useRef(0);
  const priorContentRef = useRef<{ sessionId: string | null; messages: ChatMessage[] }>({ sessionId: null, messages: [] });
  const previousTriggerRef = useRef(newSessionTrigger ?? 0);
  const imageStateRef = useRef({ sessionKey: null as string | null, enabled: showImagePreviews });
  const loadedKeyRef = useRef<string | null>(null);
  const initialScrollRef = useRef(true);
  // Armed while a session is opening. The follow reset for that open is a state
  // update scheduled by a sibling effect, so the first commit after the switch
  // still reports the previous session's scrolled-up flag; that stale flag must
  // not cancel the jump to the newest row, or a reopened conversation stayed
  // wherever it was while the backlog rendered above it.
  const openingSessionRef = useRef(false);
  const searchInProgressRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const historyLoadErrorRef = useRef(false);
  const loadedAllRef = useRef(false);
  const ignoredOffsetRef = useRef(0);
  const finishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createDiff = useMemo<DiffCalculator>(createCachedDiffCalculator, []);

  const resetPagination = useCallback((resetVisibility: boolean) => {
    ignoredOffsetRef.current = 0;
    loadingMoreRef.current = false;
    historyLoadErrorRef.current = false;
    setHistoryLoadError(false);
    setIsLoadingMoreMessages(false);
    loadedAllRef.current = false;

    setHasMoreMessages(false);
    setTotalMessages(0);
    setAllMessagesLoaded(false);
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    if (resetVisibility) setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    clearTimer(finishedTimerRef);
  }, []);

  useEffect(() => {
    const incoming = newSessionTrigger ?? 0;
    if (incoming === previousTriggerRef.current) return;
    previousTriggerRef.current = incoming;
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    setTokenBudget(null);
    applySessionState(null);
    setViewHiddenCount(0);
    setSearchTarget(null);
    initialScrollRef.current = true;
    openingSessionRef.current = true;
    beginLandingAtTail();
    setFirstPageSessionKey(null);
    searchInProgressRef.current = false;
    loadedKeyRef.current = null;
    imageStateRef.current = { sessionKey: null, enabled: showImagePreviews };
    resetPagination(true);
  }, [_onSessionIdle, applySessionState, beginLandingAtTail, newSessionTrigger, resetPagination, resetStreamingState, showImagePreviews]);

  const sessionActivity = activeSession ? processingSessions?.get(activeSession) || null : null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = Boolean(isProcessing && sessionActivity.canInterrupt);

  // The store is owned by the parent (MainContent) and marking the observed
  // session sets its state, so it must not happen during this render (React
  // reports a cross-component update on every session open). A layout effect
  // still runs before the history fetch effect below, so the store knows the
  // active session before any request or realtime emit.
  useLayoutEffect(() => { sessionStore.setActiveSession(activeSession); }, [activeSession, sessionStore]);
  const storedMessages = activeSession ? sessionStore.getMessages(activeSession) : NO_MESSAGES;
  if (messageLengthRef.current !== storedMessages.length) {
    messageLengthRef.current = storedMessages.length;
    if (viewHiddenCount) setViewHiddenCount(0);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      pendingEchoRef.current = null;
      return;
    }
    if (!activeSession || pendingEchoRef.current === pendingUserMessage) return;
    sessionStore.appendRealtime(activeSession, normalizeLocalMessage(pendingUserMessage, activeSession));
    pendingEchoRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSession, pendingUserMessage, sessionStore]);

  const chatMessages = useMemo(() => {
    const converted = normalizedToChatMessages(storedMessages);
    if (!converted.length && pendingUserMessage) return [pendingUserMessage];
    return viewHiddenCount > 0 && viewHiddenCount < converted.length
      ? converted.slice(0, converted.length - viewHiddenCount)
      : converted;
  }, [pendingUserMessage, storedMessages, viewHiddenCount]);

  const firstPageKey = activeSession ? `${activeSession}:${selectedProject?.projectId ?? ''}` : null;
  const isOpeningFirstPage = firstPageKey !== null
    && chatMessages.length === 0
    && firstPageSessionKey !== firstPageKey;
  // Everything below treats "no transcript yet" as loading: the landing holds
  // until the first page lands instead of settling on an empty pane.
  const sessionMessagesPending = isLoadingSessionMessages || isOpeningFirstPage;
  // Read frame by frame by the landing: a session reopened from a cached
  // window schedules its settle in the commit before the refetch flips the
  // loading flag, so the schedule-time check alone let the open land on the
  // old window and the new page then replaced it under a revealed transcript.
  const sessionMessagesPendingRef = useRef(sessionMessagesPending);
  sessionMessagesPendingRef.current = sessionMessagesPending;

  const addMessage = useCallback((message: ChatMessage) => {
    if (!activeSessionRef.current) {
      setPendingUserMessage(message);
      return;
    }
    const id = activeSessionRef.current;
    sessionStore.appendRealtime(id, normalizeLocalMessage(message, id));
  }, [sessionStore]);
  const clearMessages = useCallback(() => {
    if (activeSessionRef.current) sessionStore.clearRealtime(activeSessionRef.current);
  }, [sessionStore]);
  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);
  const followScrollEnabled = !isLoadingMoreMessages && !isLoadingAllMessages && !searchInProgressRef.current;
  const {
    isFollowing,
    setFollowing,
    scrollToBottom,
  } = useChatFollowScroll({ container: scrollContainer, enabled: followScrollEnabled });
  const isUserScrolledUp = !isFollowing;
  const setIsUserScrolledUp = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setFollowing(previous => {
      const scrolledUp = typeof value === 'function' ? value(!previous) : value;
      return !scrolledUp;
    });
  }, [setFollowing]);
  // The floating pill is the only explicit history control: it appears while
  // the reader is up in history with rows still unfetched or locally hidden,
  // and never beside the paged-loading spinner or a history failure banner.
  useEffect(() => {
    setShowLoadAllOverlay(
      isUserScrolledUp
      && !allMessagesLoaded
      && !historyLoadError
      && !isLoadingMoreMessages
      && (hasMoreMessages || chatMessages.length > visibleMessageCount),
    );
  }, [allMessagesLoaded, chatMessages.length, hasMoreMessages, historyLoadError, isLoadingMoreMessages, isUserScrolledUp, visibleMessageCount]);
  const isNearBottom = useCallback(() => {
    const node = scrollContainerRef.current;
    return Boolean(node && node.scrollHeight - node.scrollTop - node.clientHeight < 50);
  }, []);
  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    endLandingAtTail();
    setHasNewMessagesBelow(false);
    if (allMessagesLoaded) {
      loadedAllRef.current = false;
      setAllMessagesLoaded(false);
      setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    }
  }, [allMessagesLoaded, endLandingAtTail, scrollToBottom]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingMoreRef.current || historyLoadErrorRef.current || isLoadingMoreMessages || loadedAllRef.current || !hasMoreMessages || !selectedSession || !selectedProject) return false;
    const requestId = selectedSession.id;
    loadingMoreRef.current = true;
    setIsLoadingMoreMessages(true);
    const requestView = requestViewRef.current;
    setFollowing(false);
    try {
      const page = await sessionStore.fetchMore(requestId, { limit: PAGE_SIZE, includeImages: showImagePreviews });
      if (requestViewRef.current !== requestView) return false;
      // A superseded or no-op page is not a failure; a reconcile after a live
      // turn may discard an in-flight page and the next scroll asks again.
      if (!page) return false;
      if (page.failed || (page.addedCount === 0 && page.hasMore)) {
        // Never spin at one offset or pretend unreachable history is complete.
        historyLoadErrorRef.current = true;
        setHistoryLoadError(true);
        return false;
      }
      setHasMoreMessages(page.hasMore);
      setTotalMessages(page.total);
      if (page.addedCount > 0) setVisibleMessageCount(value => value + page.addedCount);
      if (!page.hasMore) {
        loadedAllRef.current = true;
        setAllMessagesLoaded(true);
      }
      return page.addedCount > 0;
    } finally {
      if (requestViewRef.current === requestView) {
        loadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    }
  }, [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore, setFollowing, showImagePreviews]);

  const retryOlderMessages = useCallback(() => {
    historyLoadErrorRef.current = false;
    setHistoryLoadError(false);
    void loadOlderMessages();
  }, [loadOlderMessages]);

  const handleScroll = useCallback(async () => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const bottom = isNearBottom();
    if (!bottom) {
      initialScrollRef.current = false;
      openingSessionRef.current = false;
      endLandingAtTail();
    }
    if (bottom) setHasNewMessagesBelow(false);
    // The in-flight request guard is enough. Requiring a trip away from the
    // top after every page forces a second gesture before history can continue.
    if (node.scrollTop >= 100) return;
    if (chatMessages.length > visibleMessageCount) {
      setFollowing(false);
      setVisibleMessageCount(count => count + 100);
      return;
    }
    await loadOlderMessages();
  }, [chatMessages.length, endLandingAtTail, isNearBottom, loadOlderMessages, setFollowing, visibleMessageCount]);

  useEffect(() => {
    if (!searchInProgressRef.current) {
      initialScrollRef.current = true;
      openingSessionRef.current = true;
      beginLandingAtTail();
      setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    }
    setIsUserScrolledUp(false);
  }, [beginLandingAtTail, selectedProject?.projectId, selectedSession?.id, setIsUserScrolledUp]);

  useEffect(() => {
    // Only an open lands; once it has, the follow flag owns the pane, including
    // a reader who scrolled up while a turn was streaming.
    if (!initialScrollRef.current) return;
    // The flag belongs to whatever was on screen before the open. A reopened
    // conversation must land on its newest row even when it arrives with the
    // previous one's scrolled-up state still in hand.
    if (!isFollowing) {
      if (!openingSessionRef.current) {
        initialScrollRef.current = false;
        endLandingAtTail();
        return;
      }
      setFollowing(true);
    }
    if (sessionMessagesPending || !scrollContainer) return;
    if (!chatMessages.length || searchInProgressRef.current) return;
    const node = scrollContainer;
    const progress = landingProgressRef.current;
    let frameId = 0;
    const settle = () => {
      if (!initialScrollRef.current || !scrollContainerRef.current) return;
      // The refetch for this open started between frames: wait for its page.
      // It lands the open again when the page arrives.
      if (sessionMessagesPendingRef.current) return;
      if (!progress.armedAt) progress.armedAt = Date.now();
      node.scrollTop = node.scrollHeight;
      if (node.scrollHeight === progress.height) progress.unchanged += 1;
      else {
        progress.height = node.scrollHeight;
        progress.unchanged = 0;
      }
      progress.frames += 1;
      // A live session's transcript keeps growing while it streams, so waiting
      // for the height to stop moving could keep the pane hidden for a full
      // second. Two still frames are enough to have landed; follow-scroll keeps
      // pinning the pane afterwards, so a later growth does not park it. The
      // count is shared across re-runs and wall-clock capped, so neither a
      // growing transcript nor a steady stream of arrivals can hold it.
      if (progress.unchanged < 2 && progress.frames < 12 && Date.now() - progress.armedAt < 800) {
        frameId = requestAnimationFrame(settle);
      } else {
        initialScrollRef.current = false;
        openingSessionRef.current = false;
        endLandingAtTail();
      }
    };
    frameId = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frameId);
  }, [chatMessages.length, endLandingAtTail, isFollowing, scrollContainer, sessionMessagesPending, setFollowing]);

  useEffect(() => {
    if (!selectedProject || !selectedSession) {
      if (currentSessionId && activityMapRef.current?.has(currentSessionId)) return;
      resetStreamingState();
      setCurrentSessionId(null);
      setTokenBudget(null);
      applySessionState(null);
      resetPagination(true);
      setIsLoadingSessionMessages(false);
      loadedKeyRef.current = null;
      imageStateRef.current = { sessionKey: null, enabled: showImagePreviews };
      return;
    }
    const sessionId = selectedSession.id;
    const key = `${sessionId}:${selectedProject.projectId}`;
    const oldImageState = imageStateRef.current;
    const refreshImages = shouldRefreshCachedImageWindow(oldImageState.sessionKey, oldImageState.enabled, key, showImagePreviews, sessionStore.has(sessionId));
    imageStateRef.current = { sessionKey: key, enabled: showImagePreviews };
    const subscribe = () => {
      if (!ws) return;
      statusCheckSentAtRef.current.set(sessionId, Date.now());
      sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, ...sessionStore.getReplayCursor(sessionId) }] });
    };
    if (loadedKeyRef.current === key && sessionStore.has(sessionId) && !sessionStore.isStale(sessionId)) {
      subscribe();
      setFirstPageSessionKey(key);
      if (refreshImages) void sessionStore.refreshFromServer(sessionId, { includeImages: true });
      return;
    }
    const changed = currentSessionId !== null && currentSessionId !== sessionId;
    if (changed) resetStreamingState();
    resetPagination(true);
    setViewHiddenCount(0);
    if (changed) {
      searchInProgressRef.current = false;
      setSearchTarget(null);
    }
    if (changed) setTokenBudget(null);
    // The pane outlives the selection: the first session picked after the chat
    // mounted arrives here with no previous id, so the restore follows the
    // owner rather than only a session-to-session change.
    if (sessionStateOwnerRef.current !== sessionId) applySessionState(readCachedContextFacts(sessionId));
    setCurrentSessionId(sessionId);
    subscribe();
    loadedKeyRef.current = key;
    setFirstPageSessionKey(null);
    setIsLoadingSessionMessages(true);
    const requestView = requestViewRef.current;
    sessionStore.fetchFromServer(sessionId, { limit: PAGE_SIZE, offset: 0, includeImages: showImagePreviews })
      .then(window => {
        if (requestViewRef.current !== requestView) return;
        if (window) {
          setHasMoreMessages(window.hasMore);
          setTotalMessages(window.total);
          if (window.tokenUsage) setTokenBudget(window.tokenUsage as Record<string, unknown>);
        }
        setFirstPageSessionKey(key);
        setIsLoadingSessionMessages(false);
      })
      .catch(() => {
        if (requestViewRef.current !== requestView) return;
        // A failed open still ends its loading state; the empty view plus the
        // history retry is the honest result, not a spinner forever.
        setFirstPageSessionKey(key);
        setIsLoadingSessionMessages(false);
      });
  }, [applySessionState, currentSessionId, resetPagination, resetStreamingState, selectedProject, selectedSession, sendMessage, sessionStore, showImagePreviews, statusCheckSentAtRef, ws]);

  useEffect(() => {
    const session = selectedSession as (ProjectSession & { __searchTargetSnippet?: unknown; __searchTargetTimestamp?: unknown }) | null;
    if (typeof session?.__searchTargetSnippet !== 'string' || !session.__searchTargetSnippet) return;
    searchInProgressRef.current = true;
    setSearchTarget({ snippet: session.__searchTargetSnippet, timestamp: typeof session.__searchTargetTimestamp === 'string' ? session.__searchTargetTimestamp : undefined });
  }, [selectedSession]);

  useEffect(() => {
    if (!searchTarget || !chatMessages.length || isLoadingSessionMessages) return;
    const request = searchTarget;
    const requestView = requestViewRef.current;
    setSearchTarget(null);
    const findElement = (node: HTMLDivElement): Element | null => {
      if (request.snippet) {
        const phrase = request.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim().slice(0, 80).toLowerCase();
        if (phrase.length >= 10) {
          for (const element of node.querySelectorAll('.chat-message')) {
            if ((element.textContent || '').toLowerCase().includes(phrase)) return element;
          }
        }
      }
      if (!request.timestamp) return null;
      const targetTime = new Date(request.timestamp).getTime();
      let match: Element | null = null;
      let distance = Infinity;
      for (const element of node.querySelectorAll('[data-message-timestamp]')) {
        const value = element.getAttribute('data-message-timestamp');
        if (!value) continue;
        const candidate = Math.abs(new Date(value).getTime() - targetTime);
        if (candidate < distance) {
          distance = candidate;
          match = element;
        }
      }
      return match;
    };
    const navigate = async () => {
      if (!loadedAllRef.current && selectedSession && selectedProject) {
        try {
          const window = await sessionStore.fetchFromServer(selectedSession.id, { limit: LOAD_ALL_LIMIT, offset: 0, includeImages: showImagePreviews });
          if (requestViewRef.current !== requestView) return;
          if (window) {
            setHasMoreMessages(Boolean(window.hasMore));
            setTotalMessages(window.total);
            ignoredOffsetRef.current = window.total;
            setVisibleMessageCount(Infinity);
            setAllMessagesLoaded(!window.hasMore);
            loadedAllRef.current = !window.hasMore;
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch {
          // The currently rendered message window remains searchable.
        }
      }
      if (requestViewRef.current !== requestView) return;
      setVisibleMessageCount(Infinity);
      const attempt = (remaining: number) => {
        if (requestViewRef.current !== requestView) return;
        const node = scrollContainerRef.current;
        if (!node) return;
        const element = findElement(node);
        if (element) {
          element.scrollIntoView({ block: 'center', behavior: 'smooth' });
          element.classList.add('search-highlight-flash');
          setTimeout(() => element.classList.remove('search-highlight-flash'), 4000);
          searchInProgressRef.current = false;
        } else if (remaining) {
          setTimeout(() => attempt(remaining - 1), 200);
        } else searchInProgressRef.current = false;
      };
      setTimeout(() => attempt(15), 150);
    };
    void navigate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Keyed on the ids, not the records: a project reconciled by the sidebar's
  // cache update is a new object with the same project, and re-running this on
  // every reconcile re-requested the same usage several times a turn, with the
  // request's failure clearing facts the websocket had already delivered.
  const usageProjectId = selectedProject?.projectId;
  const usageSessionId = selectedSession?.id;
  useEffect(() => {
    if (!usageProjectId || !usageSessionId) {
      setTokenBudget(null);
      applySessionState(null);
      return;
    }
    let cancelled = false;
    const loadUsage = async () => {
      try {
        const response = await authenticatedFetch(`/api/projects/${usageProjectId}/sessions/${usageSessionId}/token-usage`);
        if (response.ok) {
          const budget = await response.json();
          if (!cancelled) setTokenBudget(budget);
        }
        // A failed request is not evidence about what is already on screen. The
        // runtime sends session_state (context, model, cwd) and token_budget over
        // the websocket, while this endpoint answers 404 until a brand-new
        // session is indexed, so clearing them here made the Agent sidebar's
        // context gauge appear and then vanish a moment after it arrived.
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    void loadUsage();
    return () => { cancelled = true; };
  }, [applySessionState, usageProjectId, usageSessionId]);

  const visibleMessages = useMemo(() => chatMessages.length <= visibleMessageCount ? chatMessages : chatMessages.slice(-visibleMessageCount), [chatMessages, visibleMessageCount]);

  useEffect(() => {
    const before = priorContentRef.current;
    priorContentRef.current = { sessionId: activeSession, messages: chatMessages };
    if (before.sessionId !== activeSession) {
      setHasNewMessagesBelow(false);
      return;
    }
    if (isLoadingSessionMessages || searchInProgressRef.current || isFollowing) return;
    // Loading flags cannot identify insertion direction: pagination and realtime
    // updates may commit together, or a genuine arrival may happen mid-request.
    const showReasoning = toolOutputDensityRules(density).showReasoning;
    if (hasNewTailContent(renderedTail(before.messages, showReasoning), renderedTail(chatMessages, showReasoning))) {
      setHasNewMessagesBelow(true);
    }
  }, [activeSession, chatMessages, density, isFollowing, isLoadingSessionMessages]);
  // Scroll events the layout raises on its own - a restored offset clamping
  // when a shorter window replaces the previous transcript, a row resizing
  // under the pointer - are not the reader leaving the tail. While an open is
  // still landing the landing owns the pane; treating the event as a gesture
  // ended the landing and paginated, which parked the transcript at its top
  // with following off. Wheel, touch and keys still reach handleScroll.
  const handlePaneScroll = useCallback(() => {
    if (initialScrollRef.current) return;
    void handleScroll();
  }, [handleScroll]);

  useEffect(() => {
    const node = scrollContainer;
    if (!node) return;
    node.addEventListener('scroll', handlePaneScroll);
    return () => node.removeEventListener('scroll', handlePaneScroll);
  }, [handlePaneScroll, scrollContainer]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedProject || !selectedSession || isLoadingAllMessages) return;
    const requestId = selectedSession.id;
    const requestView = requestViewRef.current;
    loadedAllRef.current = true;
    loadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setFollowing(false);
    try {
      const window = await sessionStore.fetchFromServer(requestId, { limit: LOAD_ALL_LIMIT, offset: 0, includeImages: showImagePreviews });
      if (requestViewRef.current !== requestView) return;
      if (!window) {
        // Refused or unreachable: say so and offer the paged path instead of
        // quietly dropping the request.
        loadedAllRef.current = false;
        historyLoadErrorRef.current = true;
        setHistoryLoadError(true);
        return;
      }
      setHasMoreMessages(Boolean(window.hasMore));
      setTotalMessages(window.total);
      ignoredOffsetRef.current = window.total;
      setVisibleMessageCount(Infinity);
      setAllMessagesLoaded(!window.hasMore);
      setLoadAllJustFinished(true);
      clearTimer(finishedTimerRef);
      finishedTimerRef.current = setTimeout(() => {
        setLoadAllJustFinished(false);
        finishedTimerRef.current = null;
      }, 2500);
    } catch (error) {
      if (requestViewRef.current !== requestView) return;
      console.error('Error loading all messages:', error);
      loadedAllRef.current = false;
      historyLoadErrorRef.current = true;
      setHistoryLoadError(true);
    } finally {
      if (requestViewRef.current === requestView) {
        loadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [isLoadingAllMessages, selectedProject, selectedSession, sessionStore, setFollowing, showImagePreviews]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages: sessionMessagesPending,
    isLoadingMoreMessages,
    historyLoadError,
    retryOlderMessages,
    hasMoreMessages,
    totalMessages,
    isLandingAtTail,
    isUserScrolledUp,
    hasNewMessagesBelow,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    sessionState,
    setSessionState: applySessionState,
    visibleMessageCount,
    visibleMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    attachScrollContainer,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
