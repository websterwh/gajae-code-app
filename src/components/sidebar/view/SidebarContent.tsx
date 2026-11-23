import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { Trash2, Zap } from 'lucide-react';

import { ScrollArea } from '../../../shared/view/ui';
import { useQuickChatStore } from '../../../stores/useQuickChatStore';
import { api } from '../../../utils/api';
import { useSidebarFilter } from '../hooks/useSidebarFilter';
import type { ArchivedProjectListItem, ArchivedSessionListItem, SessionWithProvider } from '../types/types';
import { collectWorkRows, countWorkRows } from '../utils/workList';

import SidebarArchiveContent from './SidebarArchiveContent';
import SidebarFilterInput from './SidebarFilterInput';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarNavigationTabs from './SidebarNavigationTabs';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarSection from './SidebarSection';
import SidebarWorkCounts from './SidebarWorkCounts';
import SidebarWorkList from './SidebarWorkList';

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isArchiveOpen: boolean;
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  archiveLoadError: string | null;
  onOpenArchive: () => void;
  onCloseArchive: () => void;
  onRestoreArchivedProject: (projectId: string) => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onSearch: () => void;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  onOpenStats?: () => void;
  currentVersion: string;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isArchiveOpen,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  archiveLoadError,
  onOpenArchive,
  onCloseArchive,
  onRestoreArchivedProject,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onRefresh,
  isRefreshing,
  onSearch,
  onCreateProject,
  onCollapseSidebar,
  onOpenStats,
  currentVersion,
  onShowSettings,
  projectListProps,
  t,
}: SidebarContentProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [workOpen, setWorkOpen] = useState(true);
  const selectedProject = projectListProps.selectedProject;
  const availableProjects = projectListProps.projects;
  const selectedProjectIsAvailable = selectedProject !== null
    && availableProjects.some((project) => project.projectId === selectedProject.projectId);
  const canCreateSession = availableProjects.length > 0;
  // Nothing to filter and nothing to report until the first project exists:
  // the empty workspace is one action (add a project) and one line saying so.
  const hasProjects = availableProjects.length > 0 || projectListProps.isLoading;
  const filter = useSidebarFilter(projectListProps);
  const listProps = filter.listProps;
  // Counts describe the whole workspace, not the filtered view: the heading is
  // a status line, and hiding a failed run behind a filter would be a lie.
  const workRows = collectWorkRows(projectListProps);
  const workCounts = countWorkRows(workRows);
  // Work is a status area - what runs, waits, failed, or finished unread. It
  // appears when there is something to report and not before; a permanent
  // empty header asking the user to start a conversation was not status.
  const showWork = hasProjects && workRows.length > 0;
  const showsFilterEmptyState = filter.active && filter.matchCount === 0 && !projectListProps.isLoading;
  const setFilterQuery = filter.setQuery;
  const filterInputRef = filter.inputRef;
  const filterQuery = filter.query;
  const noConversationOpen = projectListProps.selectedSession === null;
  const quickChat = useQuickChatStore((state) => state.quickChat);
  // The disposable chat only earns a row once its first turn created a session;
  // before that it is just the new conversation the composer is showing.
  const quickChatTarget = (() => {
    const sessionId = quickChat?.sessionId;
    if (!sessionId) return null;
    for (const project of availableProjects) {
      const session = (project.sessions ?? []).find((entry) => String(entry.id) === sessionId);
      if (session) return { project, session: session as SessionWithProvider };
    }
    return null;
  })();

  // With no conversation open there is nowhere else for a keystroke to go, so
  // typing starts a conversation search. It is deliberately only that case: a
  // field keeps its keys, and with a chat open the composer owns them - the
  // old document-wide shortcut stole the text that was meant for the message.
  useEffect(() => {
    if (isArchiveOpen || !noConversationOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === ' ') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      event.preventDefault();
      setFilterQuery(filterQuery + event.key);
      filterInputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [filterInputRef, filterQuery, isArchiveOpen, noConversationOpen, setFilterQuery]);

  // A conversation in Work is also in its workspace's tree. Only the list the
  // user picked it from shows it selected - two highlighted rows read as two
  // selections. Work gives the highlight back once the row leaves it (a
  // finished run becomes idle when opened), and a selection that arrived
  // from elsewhere (the palette, a link) belongs to the tree.
  const [selectionOrigin, setSelectionOrigin] = useState<'tree' | 'work'>('tree');
  const selectedId = listProps.selectedSession?.id;
  const workOwnsSelection = selectionOrigin === 'work' && workRows.some((row) => row.session.id === selectedId);
  const treeProps: SidebarProjectListProps = {
    ...listProps,
    selectionShownInWork: workOwnsSelection,
    onSessionSelect: (session, projectId) => {
      setSelectionOrigin('tree');
      listProps.onSessionSelect(session, projectId);
    },
  };
  const workProps: SidebarProjectListProps = {
    ...listProps,
    selectedSession: workOwnsSelection ? listProps.selectedSession : null,
    onSessionSelect: (session, projectId) => {
      setSelectionOrigin('work');
      listProps.onSessionSelect(session, projectId);
    },
  };

  // The previous disposable chat goes when any new chat starts: that is the
  // whole point of a quick chat, and it is why starting one needs no cleanup
  // habit. Its own trash button in the row does the same on demand.
  const discardQuickChat = () => {
    const active = useQuickChatStore.getState().quickChat;
    useQuickChatStore.getState().clear();
    if (!active?.sessionId) return;
    void api.deleteSession(active.sessionId, true)
      .catch(() => undefined)
      .finally(() => onRefresh());
  };

  const createSession = () => {
    const project = selectedProjectIsAvailable ? selectedProject : availableProjects[0];
    if (!project) {
      return;
    }
    discardQuickChat();
    projectListProps.onNewSession(project);
  };

  const createQuickChat = () => {
    const project = selectedProjectIsAvailable ? selectedProject : availableProjects[0];
    if (!project) {
      return;
    }
    discardQuickChat();
    useQuickChatStore.getState().start(project.projectId, projectListProps.selectedSession?.id ?? null);
    projectListProps.onNewSession(project);
  };

  return (
    <div
      className="flex h-full flex-col bg-sidebar md:w-72 md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        onSearch={onSearch}
        onCollapseSidebar={onCollapseSidebar}
        onOpenStats={onOpenStats}
        t={t}
      />

      {!isArchiveOpen && (
        <>
          {canCreateSession && (
            <SidebarNavigationTabs
              onCreateSession={createSession}
              onCreateQuickChat={createQuickChat}
              t={t}
            />
          )}
          {quickChatTarget ? (
            <div className="mx-2 mb-2 flex items-center gap-1 rounded-lg border border-border bg-card/60 pl-2.5">
              <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                onClick={() => listProps.onSessionSelect(quickChatTarget.session, quickChatTarget.project.projectId)}
                className="min-w-0 flex-1 truncate py-1.5 text-left text-xs font-medium text-foreground"
                title="Quick chat — deleted when you start another chat"
              >
                Quick chat
              </button>
              <button
                type="button"
                onClick={discardQuickChat}
                aria-label="Delete quick chat"
                title="Delete quick chat"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}
          {hasProjects && <SidebarFilterInput value={filterQuery} onChange={setFilterQuery} inputRef={filterInputRef} t={t} />}
        </>
      )}

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {isArchiveOpen ? (
          <SidebarArchiveContent
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            archiveLoadError={archiveLoadError}
            onRetry={onOpenArchive}
            onCloseArchive={onCloseArchive}
            onRestoreArchivedProject={onRestoreArchivedProject}
            onArchivedSessionClick={onArchivedSessionClick}
            onRestoreArchivedSession={onRestoreArchivedSession}
            onDeleteArchivedSession={onDeleteArchivedSession}
            t={t}
          />
        ) : (
          <div className="space-y-2">
            {showsFilterEmptyState && (
              <p className="px-3 py-2 text-sm text-muted-foreground" role="status" data-testid="sidebar-filter-empty">
                {t('filter.noMatches', { query: filter.query.trim() })}
              </p>
            )}
            {/* Active conversations lead: they are the rows that want an
                answer, and they used to sit under every project. */}
            {showWork && (
              <SidebarSection
                id="sidebar-work"
                title={t('sessions.work')}
                open={workOpen}
                onOpenChange={setWorkOpen}
                trailing={<SidebarWorkCounts counts={workCounts} t={t} />}
              >
                <SidebarWorkList projectListProps={workProps} />
              </SidebarSection>
            )}
            <SidebarSection
              id="sidebar-projects"
              title={t('projects.title')}
              open={projectsOpen}
              onOpenChange={setProjectsOpen}
              actionLabel={t('tooltips.createProject')}
              onAction={onCreateProject}
            >
              <SidebarProjectList {...treeProps} onCreateProject={onCreateProject} showSessions />
            </SidebarSection>
          </div>
        )}
      </ScrollArea>

      <SidebarFooter
        currentVersion={currentVersion}
        onOpenArchive={onOpenArchive}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onShowSettings={onShowSettings}
        t={t}
      />
    </div>
  );
}
