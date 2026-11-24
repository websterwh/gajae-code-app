import { useEffect, useRef } from 'react';

import { collectWorkRows } from '../utils/workList';

import SidebarProjectsState from './SidebarProjectsState';
import SidebarSessionItem from './SidebarSessionItem';
import type { SidebarProjectListProps } from './SidebarProjectList';

type SidebarWorkListProps = {
  readonly projectListProps: SidebarProjectListProps;
};

export default function SidebarWorkList({ projectListProps }: SidebarWorkListProps) {
  const {
    projects,
    filteredProjects,
    selectedSession,
    isLoading,
    isMobile,
    loadingProgress,
    currentTime,
    editingSession,
    editingSessionName,
    getProjectSessions,
    onLoadMoreSessions,
    loadingMoreProjects,
    activeSessions,
    getSessionStatus,
    onProjectSelect,
    onSessionSelect,
    onDeleteSession,
    onEditingSessionNameChange,
    onStartEditingSession,
    onCancelEditingSession,
    onSaveEditingSession,
    onToggleSessionStar,
    onArchiveSession,
    onRegenerateTitle,
    onExportSession,
    onCopyDebugInfo,
    t,
  } = projectListProps;

  const sessionRows = collectWorkRows({ filteredProjects, getProjectSessions, getSessionStatus });
  // Active is a status list, not a browse: a running conversation left behind
  // a "Show more" button is exactly what this section exists to surface, so it
  // pulls every remaining page of the projects it draws from on its own. The
  // workspace trees keep their own paging.
  const pendingPages = filteredProjects
    .filter((project) => project.sessionMeta?.hasMore && !loadingMoreProjects.has(project.projectId))
    .map((project) => project.projectId);
  const pendingKey = pendingPages.join(',');
  const requestedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingKey) {
      requestedKey.current = null;
      return;
    }
    if (requestedKey.current === pendingKey) return;
    requestedKey.current = pendingKey;
    for (const projectId of pendingKey.split(',')) onLoadMoreSessions(projectId);
  }, [onLoadMoreSessions, pendingKey]);

  if (isLoading || projects.length === 0) {
    return (
      <SidebarProjectsState
        isLoading={isLoading}
        loadingProgress={loadingProgress}
        projectsCount={projects.length}
        filteredProjectsCount={filteredProjects.length}
        t={t}
      />
    );
  }

  // The host does not render the section without rows; nothing to say here.
  if (sessionRows.length === 0) return null;

  return (
    <div className="space-y-0.5 pb-1">
      {sessionRows.map(({ project, session, status }) => (
        <SidebarSessionItem
          key={`${project.projectId}:${session.id}`}
          project={project}
          session={session}
          selectedSession={selectedSession}
          isProcessing={activeSessions.has(session.id)}
          status={status}
          isMobile={isMobile}
          projectLabel={project.displayName}
          currentTime={currentTime}
          editingSession={editingSession}
          editingSessionName={editingSessionName}
          onEditingSessionNameChange={onEditingSessionNameChange}
          onStartEditingSession={onStartEditingSession}
          onCancelEditingSession={onCancelEditingSession}
          onSaveEditingSession={onSaveEditingSession}
          onToggleSessionStar={onToggleSessionStar}
          onArchiveSession={onArchiveSession}
          onRegenerateTitle={onRegenerateTitle}
          onExportSession={onExportSession}
          onCopyDebugInfo={onCopyDebugInfo}
          onProjectSelect={onProjectSelect}
          onSessionSelect={onSessionSelect}
          onDeleteSession={onDeleteSession}
          t={t}
        />
      ))}
    </div>
  );
}
