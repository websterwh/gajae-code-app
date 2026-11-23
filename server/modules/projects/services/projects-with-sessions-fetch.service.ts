import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { pruneListedSessionsWithMissingTranscripts, sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = { id: string; provider: string; summary: string; isStarred: boolean; messageCount: number; lastActivity: string };
type SessionRepositoryRow = { provider: string; session_id: string; custom_name?: string | null; isStarred: number; updated_at?: string | null; created_at?: string | null };
type InitialProjectSessionRow = SessionRepositoryRow & { project_path: string | null; total: number };
export type ProjectListItem = { projectId: string; path: string; displayName: string; fullPath: string; origin: 'legacy' | 'explicit' | 'auto'; isStarred: boolean; sessions: SessionSummary[]; sessionMeta: { hasMore: boolean; total: number } };
export type ArchivedProjectListItem = ProjectListItem & { isArchived: true };
type ProgressUpdate = { phase: 'loading' | 'complete'; current: number; total: number; currentProject?: string };
type GetProjectsWithSessionsOptions = { skipSynchronization?: boolean; sessionsLimit?: number; sessionsOffset?: number };
type SessionPaginationOptions = { limit?: number; offset?: number };
type ProjectSessionsPageResult = { sessions: SessionSummary[]; total: number; hasMore: boolean };
export type ProjectSessionsPageApiView = { projectId: string; sessions: SessionSummary[]; sessionMeta: { hasMore: boolean; total: number } };

const defaultPageSize = 20;
const maxPageSize = 200;
const initialPageSize = 5;

export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  const projectDirectory = actualProjectDir || projectName.replace(/-/g, '/');
  // Project manifests are advisory labels, so a missing or invalid one is non-fatal.
  const manifestName = await fs.readFile(path.join(projectDirectory, 'package.json'), 'utf8')
    .then((packageFile) => (JSON.parse(packageFile) as { name?: string }).name)
    .catch(() => undefined);
  if (manifestName) return manifestName;
  if (!projectDirectory.startsWith('/')) return projectDirectory;
  return projectDirectory.split('/').filter(Boolean).at(-1) || projectDirectory;
}

function pagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : defaultPageSize;
  const requestedOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;
  const bounded = {
    limit: Math.min(Math.max(1, requestedLimit), maxPageSize),
    offset: Math.max(0, requestedOffset),
  };
  return bounded;
}

function sessionSummary(session: SessionRepositoryRow): SessionSummary {
  const summary: SessionSummary = {
    id: session.session_id,
    provider: session.provider,
    summary: session.custom_name || '',
    isStarred: Boolean(session.isStarred),
    messageCount: 0, lastActivity: session.updated_at ?? session.created_at ?? new Date().toISOString(),
  };
  return summary;
}

/**
 * Runs in flight right now, from the registry the sidebar's status poll reads.
 * A project's preview page carries these first and does not count them toward
 * its limit: the five-row slice must neither hide a conversation that is still
 * working nor lose recent history because one is running.
 */
function runningSessionIds(): string[] {
  return chatRunRegistry.listRunningRuns().map((run) => run.sessionId);
}

function sessionsPage(
  projectPath: string,
  includeArchived: boolean,
  options: SessionPaginationOptions = {},
  prioritizedIds: readonly string[] = [],
): ProjectSessionsPageResult {
  const { limit, offset } = pagination(options);
  const sessions = includeArchived
    ? sessionsDb.getSessionsByProjectPathIncludingArchivedPage(projectPath, limit, offset)
    : sessionsDb.getSessionsByProjectPathPage(projectPath, limit, offset, prioritizedIds);
  const total = includeArchived
    ? sessionsDb.countSessionsByProjectPathIncludingArchived(projectPath)
    : sessionsDb.countSessionsByProjectPath(projectPath);
  const page: ProjectSessionsPageResult = {
    sessions: (sessions as SessionRepositoryRow[]).map(sessionSummary),
    total, hasMore: offset + sessions.length < total,
  };
  return page;
}

function publishProgress(progress: ProgressUpdate): void {
  const serializedProgress = JSON.stringify({ kind: 'loading_progress', ...progress });
  connectedClients.forEach((peer: RealtimeClientConnection) => {
    if (peer.readyState === WS_OPEN_STATE) peer.send(serializedProgress);
  });
}

function initialSessions(limit: number, prioritizedIds: readonly string[] = []): Map<string, ProjectSessionsPageResult> {
  const pages = new Map<string, ProjectSessionsPageResult>();
  const rows = sessionsDb.getInitialSessionPagesByProject(limit, prioritizedIds) as InitialProjectSessionRow[];
  for (const row of rows) {
    const rowPath = row.project_path;
    if (!rowPath) continue;

    const page = pages.get(rowPath);
    if (page) {
      page.sessions.push(sessionSummary(row));
      continue;
    }
    pages.set(rowPath, {
      sessions: [sessionSummary(row)],
      total: row.total,
      hasMore: false,
    });
  }
  // Live conversations come on top of the limit, so the page can hold more
  // rows than it asked for; "more" is whatever the total still has unshown.
  for (const page of pages.values()) page.hasMore = page.sessions.length < page.total;
  return pages;
}

function emptyPage(): ProjectSessionsPageResult {
  return { sessions: [], total: 0, hasMore: false };
}

function configuredProjectName(customName: string | null | undefined): string | null {
  return customName && customName.trim().length > 0 ? customName : null;
}

/**
 * Drops the rows whose transcript file is gone from the page it is about to
 * return, adjusting the totals so "show more" stays truthful. Only the listed
 * ids are checked: the whole-table sweep this replaces read and stat'ed every
 * session ever recorded on every fetch, and on a large history that blocked
 * the event loop for the first request after a restart - the very request the
 * loading screen waits on.
 */
function withoutOrphanedSessions<T extends ProjectListItem>(projects: T[]): T[] {
  const pruned = pruneListedSessionsWithMissingTranscripts(
    projects.flatMap((project) => project.sessions.map((session) => session.id)),
  );
  if (pruned.size === 0) return projects;

  return projects.map((project) => {
    const sessions = project.sessions.filter((session) => !pruned.has(session.id));
    const removed = project.sessions.length - sessions.length;
    if (removed === 0) return project;
    const total = Math.max(0, project.sessionMeta.total - removed);
    return { ...project, sessions, sessionMeta: { total, hasMore: sessions.length < total } };
  });
}

export async function getProjectsWithSessions(options: GetProjectsWithSessionsOptions = {}): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) await sessionSynchronizerService.synchronizeSessions();

  const projects = projectsDb.getProjectPaths() as Array<{ project_id: string; project_path: string; custom_project_name?: string | null; origin?: 'legacy' | 'explicit' | 'auto' | null; isStarred?: number }>;
  const sessionLimit = Math.min(Math.max(1, options.sessionsLimit ?? initialPageSize), maxPageSize);
  const prioritizedIds = runningSessionIds();
  const initialPages = initialSessions(sessionLimit, prioritizedIds);
  const result: ProjectListItem[] = [];

  for (const [index, project] of projects.entries()) {
    const projectPath = project.project_path;
    publishProgress({ phase: 'loading', current: index + 1, total: projects.length, currentProject: projectPath });

    const customName = configuredProjectName(project.custom_project_name);
    const displayName = customName ?? (options.skipSynchronization
      ? path.basename(projectPath) || projectPath
      : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath));
    const sessions = options.sessionsOffset && options.sessionsOffset > 0
      ? sessionsPage(projectPath, false, { limit: sessionLimit, offset: options.sessionsOffset }, prioritizedIds)
      : initialPages.get(projectPath) ?? emptyPage();
    result.push({
      projectId: project.project_id,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(project.isStarred),
      origin: project.origin ?? 'legacy',
      sessions: sessions.sessions,
      sessionMeta: { hasMore: sessions.hasMore, total: sessions.total },
    });
  }

  publishProgress({ phase: 'complete', current: projects.length, total: projects.length });
  // Refresh still clears a transcript deleted by hand outside the app, because
  // the rows that would have shown it are the ones checked here.
  return withoutOrphanedSessions(result);
}

/** Names and paths only; this must not load or synchronize session data. */
export function listProjectSummaries(): Array<{ projectId: string; path: string; displayName: string }> {
  const projects = projectsDb.getProjectPaths() as Array<{ project_id: string; project_path: string; custom_project_name?: string | null }>;
  return projects
    .filter((project) => typeof project.project_path === 'string' && project.project_path.trim().length > 0)
    .map((project) => ({
      projectId: project.project_id,
      path: project.project_path,
      displayName: configuredProjectName(project.custom_project_name) ?? (path.basename(project.project_path) || project.project_path),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getArchivedProjectsWithSessions(options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization' | 'sessionsLimit' | 'sessionsOffset'> = {}): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) await sessionSynchronizerService.synchronizeSessions();

  const projects = projectsDb.getArchivedProjectPaths() as Array<{ project_id: string; project_path: string; custom_project_name?: string | null; origin?: 'legacy' | 'explicit' | 'auto' | null; isStarred?: number }>;
  const result: ArchivedProjectListItem[] = [];
  for (const project of projects) {
    const projectPath = project.project_path;
    const customName = configuredProjectName(project.custom_project_name);
    const displayName = customName ?? await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);
    const sessions = sessionsPage(projectPath, true, { limit: options.sessionsLimit, offset: options.sessionsOffset });
    const archivedItem: ArchivedProjectListItem = {
      projectId: project.project_id,
      path: projectPath, fullPath: projectPath, displayName,
      isStarred: Boolean(project.isStarred),
      origin: project.origin ?? 'legacy',
      isArchived: true, sessions: sessions.sessions,
      sessionMeta: { hasMore: sessions.hasMore, total: sessions.total },
    };
    result.push(archivedItem);
  }
  return withoutOrphanedSessions(result);
}

export async function getProjectSessionsPage(projectId: string, options: SessionPaginationOptions = {}): Promise<ProjectSessionsPageApiView> {
  const project = projectsDb.getProjectById(projectId);
  if (!project) throw new AppError(`Project "${projectId}" was not found.`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });

  // The continuation pages use the same running-first order, so the client's
  // offset keeps counting through one order instead of re-sorting mid-list.
  const sessions = sessionsPage(project.project_path, false, options, runningSessionIds());
  const view: ProjectSessionsPageApiView = {
    projectId: project.project_id,
    sessions: sessions.sessions,
    sessionMeta: { hasMore: sessions.hasMore, total: sessions.total },
  };
  return view;
}
