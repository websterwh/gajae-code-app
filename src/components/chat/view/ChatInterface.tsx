import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import PermissionContext from '../../../contexts/PermissionContext';
import { displayModelId, readSessionFacts, readTokenTotals, type SessionStatusSnapshot } from '../../../contexts/sessionStatusSnapshot';
import { usePublishSessionStatus } from '../../../contexts/SessionStatusContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useProjectPermissions } from '../../../hooks/useProjectPermissions';
import type { ProjectSession } from '../../../types/app';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionLocation } from '../hooks/useSessionLocation';
import { useProjectGitSummary } from '../../workspace/hooks/useProjectGitSummary';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useEscapeToAbort } from '../hooks/useEscapeToAbort';
import { useOAuthLogin } from '../hooks/useOAuthLogin';
import type { ChatInterfaceProps } from '../types/types';
import { hasOpenDialog, shouldFocusComposer } from '../utils/composerAutoFocus';
import { deriveLiveActivity } from '../utils/toolActivity';
import OAuthLoginDialog from '../OAuthLoginDialog';
import { useGoalControls } from '../hooks/useGoalControls';

import SessionWorktreePicker from './SessionWorktreePicker';
import GoalControls from './GoalControls';
import ChatComposer from './ChatComposer';
import ChatMessagesPane from './ChatMessagesPane';
import CommandResultModal from './CommandResultModal';
import BtwPanel from './BtwPanel';
import { isReasoningEffort, readReasoningEffort, rememberReasoningEffort, type ReasoningEffort } from './reasoningEffort';

function ComposerSurface(props: ComponentProps<typeof ChatComposer>) {
  return <ChatComposer {...props} />;
}

function ProjectSelectionNotice({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center text-muted-foreground">
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}

export function isHistoricalNonGjcReadOnlySession(selectedSession: ProjectSession | null): boolean {
  const sourceProvider = selectedSession?.provider ?? selectedSession?.__provider;
  return Boolean(sourceProvider && sourceProvider !== 'gjc');
}

function ChatInterface({
  selectedProject, selectedSession, ws, sendMessage, onFileOpen, onInputFocusChange,
  onSessionProcessing, onSessionIdle, processingSessions, onNavigateToSession,
  onSessionEstablished, onShowSettings, toolOutputDensity,
  showImagePreviews, sendByCtrlEnter, newSessionTrigger, sessionStore,
}: ChatInterfaceProps) {
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const statusCheckSentAtRef = useRef(new Map<string, number>());

  const clearStreaming = useCallback(() => {
    const timer = streamTimerRef.current;
    if (timer) cancelAnimationFrame(timer);
    streamTimerRef.current = null;
    accumulatedStreamRef.current = '';
  }, []);

  const {
    gjcModel, sessionPinnedModel, pendingPermissionRequests, setPendingPermissionRequests,
    providerModelCatalog, providerModelCacheCatalog, providerModelsRefreshing,
    providerModelsLoading, hardRefreshProviderModels, selectProviderModel,
  } = useChatProviderState({ selectedSession, selectedProject });
  const oauthLogin = useOAuthLogin();
  const projectPermissions = useProjectPermissions(selectedProject?.projectId);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(readReasoningEffort);
  const reasoningSessionRef = useRef<string | null>(selectedSession?.id ?? null);
  // The session whose turn the user stopped. Its answer stays on screen, so
  // the retry control follows that turn until the next run starts.
  const [stoppedTurnSession, setStoppedTurnSession] = useState<string | null>(null);
  const [btwQuestion, setBtwQuestion] = useState<string | null>(null);
  // Remounting the panel is what starts a different side chat; its question and
  // exchanges deliberately live only for as long as the drawer is open.
  const [btwKey, setBtwKey] = useState(0);

  useEffect(() => {
    if (oauthLogin.attempt?.phase === 'completed') void hardRefreshProviderModels();
  }, [hardRefreshProviderModels, oauthLogin.attempt?.phase]);

  const session = useChatSessionState({
    selectedProject, selectedSession, ws, sendMessage, newSessionTrigger, processingSessions,
    onSessionIdle, resetStreamingState: clearStreaming, statusCheckSentAtRef,    sessionStore,
    showImagePreviews,
    density: toolOutputDensity,
  });

  const { setCurrentSessionId } = session;
  const locationSessionId = selectedSession?.id ?? session.currentSessionId;
  const sessionLocation = useSessionLocation(locationSessionId);
  // A managed worktree is a git worktree, so it exists only for a repository.
  // The summary is the same query the Environment rail already runs, and it is
  // the only thing here that knows the answer: until it does, or when it says
  // no, the picker stays on the project so the worktree route is never called
  // where it would simply fail.
  const projectGit = useProjectGitSummary(selectedProject?.projectId, Boolean(selectedProject?.projectId), locationSessionId ?? undefined, selectedProject?.fullPath);
  // A managed worktree needs the project directory itself to be the repository
  // root with at least one commit. A plain folder, a `git init` with no commit
  // yet, and a subdirectory of a larger repository all run in the project
  // directory, where a session starts without one.
  const worktreeAvailable = projectGit.state.kind === 'ready' && projectGit.state.summary.worktreeEligible;
  const establishSession = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((id, context) => {
    setCurrentSessionId(id);
    onSessionEstablished?.(id, context);
    onNavigateToSession?.(id);
  }, [onNavigateToSession, onSessionEstablished, setCurrentSessionId]);

  // GJC's own `/retry`: the runtime drops the failed tail from the resumed
  // conversation and issues the same prompt again, so a retry re-runs the turn
  // instead of stacking a second copy of it, and the session's pinned model
  // still answers it. This is not limited to a transcript that ends in an
  // error: a turn cut off when a provider ran out of usage is retried after
  // switching models, and the last row is then an ordinary assistant message.
  const appendSessionMessage = session.addMessage;
  const retryFailedTurn = useCallback(() => {
    const sessionId = session.currentSessionId ?? selectedSession?.id ?? null;
    const notice = (content: string) => appendSessionMessage({
      type: 'system', isSystemNotice: true, noticeLevel: 'info', content, timestamp: new Date(),
    });
    if (!sessionId) return;
    // Retrying sends a frame with no visible body of its own, so every path
    // says something in the transcript: silence read as the command doing
    // nothing at all.
    if (session.isProcessing) {
      notice('Retry is waiting: this turn is still running. Send /retry again once it finishes.');
      return;
    }
    const content = [...session.chatMessages]
      .reverse()
      .find((message) => message.type === 'user' && String(message.content ?? '').trim().length > 0)?.content;
    if (content === undefined || content === null) {
      notice('Nothing to retry yet: this conversation has no message from you.');
      return;
    }
    // A disconnected socket used to make this a silent no-op: the frame was
    // dropped and nothing appeared anywhere, so the click looked broken rather
    // than the connection. Say what actually happened.
    const accepted = sendMessage({ type: 'chat.send', sessionId, content: String(content), options: { retryLastTurn: true } });
    if (accepted === false) {
      appendSessionMessage({ type: 'error', content: 'Not sent: the chat socket is not connected. Reconnect, then retry.', timestamp: new Date() });
      return;
    }
    notice('Retrying the last turn.');
  }, [appendSessionMessage, selectedSession?.id, sendMessage, session.chatMessages, session.currentSessionId, session.isProcessing]);

  const openSideChat = useCallback((question: string) => {
    const trimmed = question.trim();
    if (!trimmed) {
      appendSessionMessage({ type: 'assistant', content: t('btw.usage', { defaultValue: 'Usage: /btw <question>' }), timestamp: Date.now() });
      return;
    }
    if (!(session.currentSessionId || selectedSession?.id)) {
      appendSessionMessage({ type: 'assistant', content: t('btw.noSession', { defaultValue: 'Send a message first: there is no conversation context for a side chat yet.' }), timestamp: Date.now() });
      return;
    }
    setBtwQuestion(trimmed);
    setBtwKey((key) => key + 1);
  }, [appendSessionMessage, selectedSession?.id, session.currentSessionId, t]);

  const composer = useChatComposerState({
    executionCwd: sessionLocation.data?.cwd,
    // An unattended run commits, pushes and switches branches on whatever
    // checkout it was given, so a repository session starts isolated and the
    // user opts back into the shared checkout rather than out of it.
    defaultUseWorktree: worktreeAvailable,
    selectedProject,
    selectedSession,
    currentSessionId: session.currentSessionId,
    gjcModel,
    reasoningEffort,
    isLoading: session.isProcessing,
    canAbortSession: session.canAbortSession,
    tokenBudget: session.tokenBudget,
    // This session's own model, not the standing choice this browser last
    // saved: the telemetry panel names whichever model is on screen.
    telemetryModel: displayModelId(sessionPinnedModel, readSessionFacts(session.sessionState).modelId) ?? null,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: establishSession,
    onInputFocusChange,
    onShowSettings,
    scrollToBottom: session.scrollToBottom,
    onLogin: oauthLogin.openLogin,
    addMessage: session.addMessage,
    setIsUserScrolledUp: session.setIsUserScrolledUp,
    setPendingPermissionRequests,
    onRetryLastTurn: retryFailedTurn,
    onOpenSideChat: openSideChat,
  });

  // Stop is offered by the composer's button and by Escape; both are routed
  // through here so the transcript can offer the retry control for the turn
  // the user stopped, exactly as /retry does.
  const abortSession = composer.handleAbortSession;
  const requestAbort = useCallback(() => {
    if (session.canAbortSession) setStoppedTurnSession(session.currentSessionId ?? selectedSession?.id ?? null);
    abortSession();
  }, [abortSession, selectedSession?.id, session.canAbortSession, session.currentSessionId]);

  // A stopped turn stays retryable until the next run starts: from then on the
  // transcript's tail belongs to that run, not to the turn that was stopped.
  const wasProcessingRef = useRef(session.isProcessing);
  useEffect(() => {
    if (session.isProcessing && !wasProcessingRef.current) setStoppedTurnSession(null);
    wasProcessingRef.current = session.isProcessing;
  }, [session.isProcessing]);

  // Typing with nothing focused is meant for the conversation. Without this the
  // keystroke went to whichever field held focus last - in practice the sidebar
  // conversation filter - so the message was never written.
  useEffect(() => {
    const focusComposer = (event: KeyboardEvent) => {
      if (!composer.textareaRef.current) return;
      if (!shouldFocusComposer(event, hasOpenDialog())) return;
      composer.textareaRef.current.focus();
    };
    document.addEventListener('keydown', focusComposer);
    return () => document.removeEventListener('keydown', focusComposer);
  }, [composer.textareaRef]);


  // "New work item" while a fresh conversation is already on screen changes
  // nothing visible — same project, same composer — so the click reads as
  // dead. The state reset happens in the session-state hook; here the click
  // also lands the cursor in the box, which is the only feedback that state
  // can offer.
  const previousFocusTrigger = useRef(newSessionTrigger ?? 0);
  useEffect(() => {
    if ((newSessionTrigger ?? 0) === previousFocusTrigger.current) return;
    previousFocusTrigger.current = newSessionTrigger ?? 0;
    composer.textareaRef.current?.focus();
  }, [composer.textareaRef, newSessionTrigger]);
  useEffect(() => {
    const prior = reasoningSessionRef.current;
    const selected = selectedSession?.id ?? null;
    // Leaving a session drops the level its run reported, not the user's own
    // choice: the composer sends its effort with every message, so what it
    // shows for the next session is the standing choice, not "Default".
    if (prior && prior !== selected) setReasoningEffort(readReasoningEffort());
    reasoningSessionRef.current = selected;
  }, [selectedSession?.id]);

  const chooseReasoningEffort = useCallback((value: ReasoningEffort) => {
    rememberReasoningEffort(value);
    setReasoningEffort(value);
  }, []);

  useEffect(() => {
    const serverValue = session.sessionState?.thinkingLevel;
    if (typeof serverValue === 'string' && isReasoningEffort(serverValue)) setReasoningEffort(serverValue);
  }, [session.sessionState?.thinkingLevel]);

  const reconnectChat = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId: selectedSession.id, ...sessionStore.getReplayCursor(selectedSession.id) }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider: 'gjc',
    selectedSession,
    currentSessionId: session.currentSessionId,
    setTokenBudget: session.setTokenBudget,
    setSessionState: session.setSessionState,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: reconnectChat,
    onSteerResult: composer.resolveSteerResult,
    sessionStore,
  });

  useEscapeToAbort(session.canAbortSession, requestAbort);

  useEffect(() => clearStreaming, [clearStreaming]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision: composer.handlePermissionDecision,
  }), [composer.handlePermissionDecision, pendingPermissionRequests]);

  const sessionStatusSnapshot = useMemo<SessionStatusSnapshot>(() => {
    const reported = readSessionFacts(session.sessionState);
    const fallbackModel = displayModelId(gjcModel);
    return {
      ...reported,
      sessionId: session.currentSessionId ?? selectedSession?.id ?? null,
      modelId: displayModelId(sessionPinnedModel, reported.modelId, fallbackModel),
      thinkingLevel: reported.thinkingLevel ?? reasoningEffort,
      tokens: readTokenTotals(session.tokenBudget),
      activity: {
        running: session.isProcessing,
        statusText: typeof session.sessionActivity?.statusText === 'string' ? session.sessionActivity.statusText : null,
        queued: composer.queuedDrafts.length,
      },
    };
  }, [
    composer.queuedDrafts.length, gjcModel, reasoningEffort, selectedSession?.id,
    session.currentSessionId, session.isProcessing, session.sessionActivity?.statusText,
    session.sessionState, session.tokenBudget, sessionPinnedModel,
  ]);
  usePublishSessionStatus(sessionStatusSnapshot);

  const historicalSession = isHistoricalNonGjcReadOnlySession(selectedSession);
  const goalControls = useGoalControls(historicalSession ? null : session.currentSessionId ?? selectedSession?.id ?? null, selectedProject?.projectId ?? null);
  const showLanding = !historicalSession
    && !selectedSession
    && !session.currentSessionId
    && session.chatMessages.length === 0;
  // The run's progress has one home, the transcript: the running turn's work
  // block (or, at detailed density, a bare running row) reads this.
  const liveActivity = session.isProcessing
    ? deriveLiveActivity(session.chatMessages, {
      statusText: session.sessionActivity?.statusText,
      awaitingInput: Boolean(session.sessionActivity?.awaitingInput) || pendingPermissionRequests.length > 0,
    })
    : null;

  const endsInFailure = session.chatMessages[session.chatMessages.length - 1]?.type === 'error';

  // A stopped turn has no failure row, but /retry still applies to it: the
  // tail offers the same control a failed turn shows, and both run
  // `retryFailedTurn`, so the command and the button cannot drift apart.
  const stoppedTurnKey = session.currentSessionId ?? selectedSession?.id ?? null;
  const retryStoppedTurn = !historicalSession && !endsInFailure && !session.isProcessing
    && stoppedTurnSession !== null && stoppedTurnSession === stoppedTurnKey
    ? retryFailedTurn
    : undefined;

  if (!selectedProject) {
    return <ProjectSelectionNotice text={t('projectSelection.startChatWithProvider', {
      provider: 'Gajae Code',
      defaultValue: 'Select a project to start chatting with {{provider}}',
    })} />;
  }

  const composerNode = (
    <ComposerSurface
      composerFrozen={composer.composerFrozen}
      voiceOwnerKey={JSON.stringify([selectedProject.projectId, selectedSession?.id || session.currentSessionId || null])}
      draftPersistence={composer.draftPersistence}
      onRetryDraftPersistence={composer.retryDraftPersistence}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={composer.handlePermissionDecision}
      isLoading={session.isProcessing}
      onAbortSession={requestAbort}
      sessionState={session.sessionState}
      onShowTokenUsage={composer.showCostModal}
      onSubmit={composer.handleSubmit}
      onSteer={composer.handleSteer}
      isDragActive={composer.isDragActive}
      sessionPinnedModel={sessionPinnedModel}
      sessionLocationControl={worktreeAvailable || locationSessionId
        ? <SessionWorktreePicker value={composer.useWorktree} onChange={composer.setUseWorktree} sessionId={locationSessionId} location={sessionLocation.data} disabled={session.isProcessing} />
        : null}
      queuedDrafts={composer.queuedDrafts}
      onEditQueuedDraft={composer.editQueuedDraft}
      onDeleteQueuedDraft={composer.deleteQueuedDraft}
      onMoveQueuedDraft={composer.moveQueuedDraft}
      attachedImages={composer.attachedImages}
      onRemoveImage={(index) => composer.setAttachedImages((images) => images.filter((_, imageIndex) => imageIndex !== index))}
      attachmentNotice={composer.attachmentNotice}
      onDismissAttachmentNotice={composer.dismissAttachmentNotice}
      showFileDropdown={composer.showFileDropdown}
      filteredFiles={composer.filteredFiles}
      selectedFileIndex={composer.selectedFileIndex}
      onSelectFile={composer.selectFile}
      filteredCommands={composer.filteredCommands}
      skillCommands={composer.skillCommands}
      selectedCommandIndex={composer.selectedCommandIndex}
      onCommandSelect={composer.handleCommandSelect}
      onCloseCommandMenu={composer.resetCommandMenuState}
      isCommandMenuOpen={composer.showCommandMenu}
      frequentCommands={composer.commandQuery ? [] : composer.frequentCommands}
      getRootProps={composer.getRootProps}
      getInputProps={composer.getInputProps}
      openImagePicker={composer.openImagePicker}
      inputHighlightRef={composer.inputHighlightRef}
      renderInputWithMentions={composer.renderInputWithMentions}
      textareaRef={composer.textareaRef}
      input={composer.input}
      onVoiceTranscript={composer.handleVoiceTranscript}
      onVoicePartial={composer.handleVoicePartial}
      onVoiceReset={composer.handleVoicePartialReset}
      onInputChange={composer.handleInputChange}
      onTextareaClick={composer.handleTextareaClick}
      onTextareaKeyDown={composer.handleKeyDown}
      onTextareaPaste={composer.handlePaste}
      onTextareaScrollSync={composer.syncInputOverlayScroll}
      onTextareaInput={composer.handleTextareaInput}
      onInputFocusChange={composer.handleInputFocusChange}
      placeholder={t('input.placeholder', { provider: 'Gajae Code' })}
      isTextareaExpanded={composer.isTextareaExpanded}
      sendByCtrlEnter={sendByCtrlEnter}
      modelPreset={gjcModel}
      modelPresetOptions={providerModelCatalog.gjc?.OPTIONS ?? []}
      modelOptions={providerModelCatalog.gjc?.MODELS ?? []}
      availabilityKnown={Array.isArray(providerModelCatalog.gjc?.MODELS)}
      modelPresetsLoading={providerModelsLoading}
      modelPickerOpenTrigger={composer.modelPickerTrigger}
      onSelectModelPreset={(model) => selectProviderModel('gjc', model, session.currentSessionId || selectedSession?.id || null)}
      reasoningEffort={reasoningEffort}
      onSelectReasoningEffort={chooseReasoningEffort}
      permissions={projectPermissions.permissions}
      onSelectPermissionMode={projectPermissions.setMode}
      permissionsBusy={projectPermissions.isSettingMode}
      isWorkspace={composer.isWorkspace}
      workspaceRootName={selectedProject.displayName}
      workspaceCandidates={composer.workspaceCandidates}
      workspaceTarget={composer.workspaceTargetValue}
      onPickWorkspaceTarget={composer.pickWorkspaceTarget}
    />
  );

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        {!historicalSession && (session.currentSessionId || selectedSession?.id) && <GoalControls key={`${selectedProject.projectId}:${session.currentSessionId ?? selectedSession?.id}`} {...goalControls} />}
        {showLanding ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-[10vh] sm:px-6">
            <div className="w-full max-w-184">
              <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {t('newSession.greeting', { defaultValue: 'What are we building today?' })}
              </h1>
              <p className="mt-2 mb-8 text-center text-sm text-muted-foreground">
                {t('newSession.subtitle', { project: selectedProject.displayName, defaultValue: 'Gajae Code is ready to work in {{project}}.' })}
              </p>
              {composerNode}
            </div>
          </div>
        ) : (
          <>
            <ChatMessagesPane
              scrollContainerRef={session.scrollContainerRef}
              attachScrollContainer={session.attachScrollContainer}
              preserveScrollPosition={session.isUserScrolledUp && !session.isLoadingSessionMessages}
              isLandingAtTail={session.isLandingAtTail}
              onWheel={session.handleScroll}
              onTouchMove={session.handleScroll}
              isLoadingSessionMessages={session.isLoadingSessionMessages}
              isProcessing={session.isProcessing}
              liveActivity={liveActivity}
              runStartedAt={session.sessionActivity?.startedAt ?? null}
              chatMessages={session.chatMessages}
              selectedSession={selectedSession}
              currentSessionId={session.currentSessionId}
              provider="gjc"
              isLoadingMoreMessages={session.isLoadingMoreMessages}
              historyLoadError={session.historyLoadError}
              retryOlderMessages={session.retryOlderMessages}
              totalMessages={session.totalMessages}
              visibleMessages={session.visibleMessages}
              loadAllMessages={session.loadAllMessages}
              allMessagesLoaded={session.allMessagesLoaded}
              isLoadingAllMessages={session.isLoadingAllMessages}
              loadAllJustFinished={session.loadAllJustFinished}
              showLoadAllOverlay={session.showLoadAllOverlay}
              retryFailedTurn={endsInFailure ? retryFailedTurn : undefined}
              stoppedTurnRetry={retryStoppedTurn}
              createDiff={session.createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              density={toolOutputDensity}
              showImagePreviews={showImagePreviews}
              selectedProject={selectedProject}
            />
            <div className="relative shrink-0">
              {session.isUserScrolledUp && session.chatMessages.length > 0 && (
                // At the column's trailing edge, as a native chat places it:
                // centred, the button sat on the line being read.
                <div className="pointer-events-none absolute inset-x-0 -top-11 z-20 px-2 sm:px-4">
                  <div className="mx-auto flex max-w-chat justify-end px-2">
                    <button
                      type="button"
                      onClick={session.scrollToBottomAndReset}
                      aria-label={t('input.scrollToBottom', { defaultValue: 'Jump to latest' })}
                      title={t('input.scrollToBottom', { defaultValue: 'Jump to latest' })}
                      className={session.hasNewMessagesBelow
                        ? 'pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-3 text-xs font-medium text-primary-foreground shadow-md transition-all duration-200 hover:brightness-110'
                        : 'pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-md backdrop-blur-sm transition-colors duration-150 hover:bg-accent hover:text-foreground'}
                    >
                      {session.hasNewMessagesBelow && <span>{t('input.newMessages', { defaultValue: 'New messages' })}</span>}
                      <ArrowDownIcon className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              )}
              {!historicalSession && composerNode}
            </div>
          </>
        )}
      </div>
      <CommandResultModal
        payload={composer.commandModalPayload}
        onClose={composer.closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={session.currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
      {btwQuestion !== null && (
        <BtwPanel
          key={btwKey}
          question={btwQuestion}
          sessionId={session.currentSessionId || selectedSession?.id || null}
          onClose={() => setBtwQuestion(null)}
        />
      )}
      <OAuthLoginDialog
        open={oauthLogin.isOpen}
        providers={oauthLogin.providers}
        isLoadingProviders={oauthLogin.isLoadingProviders}
        isStarting={oauthLogin.isStarting}
        attempt={oauthLogin.attempt}
        failure={oauthLogin.failure}
        onSelectProvider={oauthLogin.startProvider}
        onSubmitValue={oauthLogin.submitValue}
        onDismiss={oauthLogin.closeLogin}
        onRetry={oauthLogin.retry}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
