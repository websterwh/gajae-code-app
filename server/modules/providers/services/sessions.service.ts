import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getGjcWorkerSupervisor, isGjcSessionActive } from '@/gjc-worker-client.js';
import { relocateLiveGjcTranscript } from '@/gjc-transcript-store.js';
import { projectsDb, sessionsDb, sessionWorktreesDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { resolveSessionProjectPath } from '@/modules/providers/services/session-project-path.service.js';
import { releaseWorktreeSession, sessionTranscriptWorkspace } from '@/modules/providers/services/session-worktrees.service.js';
import { createQuickChatWorkspace, removeQuickChatWorkspace } from '@/modules/providers/services/quick-chat-workspace.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { FetchHistoryOptions, FetchHistoryResult, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { boundToolResultDetails, prepareMessagesForTransport } from '@/shared/tool-output-transport.js';
import { AppError } from '@/shared/utils.js';

type SessionProjectResult = { projectId: string; path: string; fullPath: string; displayName: string; isStarred: boolean; origin: 'legacy' | 'explicit' | 'auto' };
type CreateAppSessionResult = { sessionId: string; provider: LLMProvider; projectPath: string; project?: SessionProjectResult };
type ArchivedSessionListItem = { sessionId: string; provider: LLMProvider; projectId: string | null; projectPath: string | null; projectDisplayName: string; sessionTitle: string; createdAt: string | null; updatedAt: string | null; lastActivity: string | null; isStarred: boolean; isProjectArchived: boolean };

function sessionNotFound(sessionId: string): AppError {
  return new AppError(`Session "${sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
}

function archivedProjectName(projectPath: string | null, configuredName: string | null | undefined): string {
  const preferred = typeof configuredName === 'string' ? configuredName.trim() : '';
  if (preferred) return preferred;
  return projectPath ? path.basename(projectPath) || projectPath : 'Unknown Project';
}

async function unlinkWhenPresent(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function requiredSession(sessionId: string) {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) throw sessionNotFound(sessionId);
  return row;
}

export function prepareHistoryMessagesForTransport(messages: NormalizedMessage[], includeImages = true): NormalizedMessage[] {
  return prepareMessagesForTransport(messages, includeImages);
}

export const COMPLETE_HISTORY_PAGE_SIZE = 500;

/**
 * Walks a transcript newest-first in bounded pages. Unbounded provider reads
 * are rejected past the page cap, so in-server consumers that need the whole
 * conversation, or one row somewhere in it, page instead. A tail that grows
 * between pages only shifts later offsets forward; the rows it re-serves are
 * already known and skipped, so nothing is dropped.
 *
 * `until` stops the walk early once the newest pages already satisfy the caller.
 */
export async function fetchCompleteHistory(
  sessionId: string,
  options: Omit<FetchHistoryOptions, 'limit' | 'offset'> & { providerSessionId: string; provider: LLMProvider },
  until?: (page: NormalizedMessage[]) => boolean,
): Promise<FetchHistoryResult> {
  const { provider: providerName, ...providerOptions } = options;
  const provider = providerRegistry.resolveProvider(providerName);
  const messages: NormalizedMessage[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let last: FetchHistoryResult | null = null;
  for (;;) {
    const page = await provider.sessions.fetchHistory(sessionId, { ...providerOptions, limit: COMPLETE_HISTORY_PAGE_SIZE, offset });
    last = page;
    const fresh = page.messages.filter((message) => !seen.has(message.id));
    for (const message of fresh) seen.add(message.id);
    messages.unshift(...fresh);
    if (!page.hasMore || page.messages.length === 0 || until?.(fresh)) break;
    offset += page.messages.length;
  }
  return { ...last, messages, total: last.total, hasMore: false, offset: 0, limit: null };
}

/**
 * A workspace row lives in the data volume; its folder does not. A container
 * rebuild can leave the row without its directory, and every new session then
 * failed with "Project directory is unavailable." Recreate the empty folder the
 * app would have made - only for a path the app already knows, never for an
 * arbitrary path someone typed.
 */
async function restoreKnownProjectDirectory(input: string): Promise<void> {
  const requested = input.trim();
  if (!requested) return;
  let known = false;
  try { known = Boolean(projectsDb.getProjectPath(requested)); } catch { return; }
  if (!known) return;
  try {
    await fsp.stat(requested);
  } catch {
    await fsp.mkdir(requested, { recursive: true }).catch(() => undefined);
  }
}

export const sessionsService = {
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map(({ id }) => id);
  },

  listRunningSessions(): ReturnType<typeof chatRunRegistry.listRunningRuns> {
    return chatRunRegistry.listRunningRuns();
  },

  normalizeMessage(providerName: string, raw: unknown, sessionId: string | null): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  async createAppSession(provider: LLMProvider, projectPath: string): Promise<CreateAppSessionResult> {
    await restoreKnownProjectDirectory(projectPath);
    const project = await resolveSessionProjectPath(projectPath);
    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, project);
    return { sessionId, provider, projectPath: project };
  },

  /**
   * A quick chat's first turn gets its own throwaway folder instead of the
   * project the sidebar was showing. The session row points at that folder so
   * the run's cwd is the disposable workspace, and a hard delete removes it.
   */
  async createQuickChatSession(provider: LLMProvider): Promise<CreateAppSessionResult> {
    const sessionId = randomUUID();
    const projectPath = await createQuickChatWorkspace(sessionId);
    try {
      sessionsDb.createAppSession(sessionId, provider, projectPath);
    } catch (error) {
      await removeQuickChatWorkspace(sessionId, projectPath);
      throw error;
    }
    // `createAppSession` registered the disposable folder so the session has
    // a project row like any other. Return that row: the browser must file and
    // reopen the quick chat there, not under whichever workspace launched it.
    const stored = projectsDb.getProjectPath(projectPath);
    const project = stored ? {
      projectId: stored.project_id,
      path: projectPath,
      fullPath: projectPath,
      displayName: stored.custom_project_name?.trim() || path.basename(projectPath) || projectPath,
      isStarred: Boolean(stored.isStarred),
      origin: stored.origin ?? 'auto' as const,
    } : undefined;
    return { sessionId, provider, projectPath, ...(project ? { project } : {}) };
  },

  /**
   * Native fork (whole session) or native branch at one entry — the step `/tree`
   * performs — followed by the app-side row that points at the successor.
   *
   * The SDK owns the transcript: `SessionManager.fork()` copies it and
   * `createBranchedSession(entryId)` starts a new file at that entry. What the
   * SDK cannot know is the app's own mapping, and without it the successor is
   * invisible: history, the sidebar and resume all read a row, so one is
   * registered for the id the worker returns.
   */
  async branchSession(sessionId: string, entryId?: string): Promise<{ sessionId: string; providerSessionId: string }> {
    const row = requiredSession(sessionId);
    if (row.provider !== 'gjc' || !row.provider_session_id) throw sessionNotFound(sessionId);
    const projectPath = await resolveSessionProjectPath(row.project_path ?? '');
    const scope = { appSessionId: row.session_id, cwd: projectPath, owner: `session:${row.session_id}` };
    const supervisor = getGjcWorkerSupervisor();
    const successor = entryId
      ? await supervisor.branchSession(scope, row.provider_session_id, entryId)
      : await supervisor.forkSession(scope, row.provider_session_id);
    return {
      // The row carries the successor's transcript: history, the sidebar and
      // resume all resolve through it, so a row without one looks empty.
      sessionId: sessionsDb.createSession(
        successor.sessionId, row.provider, projectPath, undefined, undefined, undefined, successor.transcriptPath,
      ),
      providerSessionId: successor.sessionId,
    };
  },

  /**
   * `/move`: repoints the session at another existing folder. The SDK owns the
   * transcript relocation (header cwd, artifacts, locks); the app row follows
   * it so the sidebar and the next turn read the new project. A session without
   * a transcript yet has nothing to relocate and only changes its binding.
   */
  async moveSession(sessionId: string, targetPath: string): Promise<{ sessionId: string; projectPath: string; moved: boolean }> {
    const row = requiredSession(sessionId);
    if (row.provider !== 'gjc') {
      throw new AppError('Only Gajae Code sessions can be moved between folders.', { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
    }
    const requested = targetPath.trim();
    if (!requested) throw new AppError('A destination folder is required.', { code: 'INVALID_MOVE_TARGET', statusCode: 400 });
    const expanded = requested.startsWith('~') ? path.join(os.homedir(), requested.slice(1)) : requested;
    const target = path.resolve(row.project_path?.trim() || process.cwd(), expanded);
    let metadata;
    try {
      metadata = await fsp.stat(target);
    } catch {
      throw new AppError(`Directory does not exist or is not a directory: ${target}`, { code: 'INVALID_MOVE_TARGET', statusCode: 400 });
    }
    if (!metadata.isDirectory()) {
      throw new AppError(`Directory does not exist or is not a directory: ${target}`, { code: 'INVALID_MOVE_TARGET', statusCode: 400 });
    }
    if (sessionWorktreesDb.get(row.session_id)) {
      throw new AppError('This session runs in a managed worktree; release it before moving it elsewhere.', { code: 'SESSION_MOVE_WORKTREE', statusCode: 409 });
    }
    if (row.provider_session_id && isGjcSessionActive(row.provider_session_id)) {
      throw new AppError('Wait for the current turn to finish before moving this session.', { code: 'RUN_IN_PROGRESS', statusCode: 409 });
    }

    // An older transcript may still sit in the app's own flat store, which the
    // SDK cannot relocate across roots. Bring it to the CLI-visible store first.
    await relocateLiveGjcTranscript(row.session_id).catch(() => undefined);
    const current = requiredSession(sessionId);
    let transcriptPath: string | undefined;
    let movedCwd: string | undefined;
    if (current.provider_session_id && current.jsonl_path) {
      try {
        const result = await getGjcWorkerSupervisor().moveSession({
          appSessionId: current.session_id,
          cwd: current.project_path ?? target,
          owner: `session:${current.session_id}`,
        }, current.provider_session_id, target);
        transcriptPath = result.transcriptPath;
        movedCwd = result.cwd;
      } catch (error) {
        throw new AppError(error instanceof Error ? error.message : 'The session could not be moved.', {
          code: 'SESSION_MOVE_FAILED', statusCode: 409,
        });
      }
    }
    const projectPath = movedCwd ?? target;
    projectsDb.ensureProjectPathForSession(projectPath);
    sessionsDb.updateSessionProjectPath(sessionId, projectPath, transcriptPath);
    return { sessionId, projectPath, moved: true };
  },

  async fetchHistory(sessionId: string, options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'includeImages'> = {}): Promise<FetchHistoryResult> {
    const row = requiredSession(sessionId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? null;
    if (!row.provider_session_id) return { messages: [], total: 0, hasMore: false, offset, limit };

    const provider = providerRegistry.resolveProvider(row.provider as LLMProvider);
    const history = await provider.sessions.fetchHistory(sessionId, {
      limit,
      offset,
      projectPath: sessionTranscriptWorkspace(sessionId, row.project_path ?? ''),
      providerSessionId: row.provider_session_id,
    });
    const remapped = history.messages.map((message) => ({ ...message, sessionId }));
    return { ...history, messages: prepareHistoryMessagesForTransport(remapped, options.includeImages !== false) };
  },

  async fetchToolResult(sessionId: string, toolId: string): Promise<{ toolId: string; toolResult: NonNullable<NormalizedMessage['toolResult']>; toolDetailsOmitted?: boolean }> {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row?.provider_session_id) throw sessionNotFound(sessionId);
    const embeddedResult = (message: NormalizedMessage) => (message.kind === 'tool_use' && message.toolId === toolId ? message.toolResult : undefined);
    const independentResult = (message: NormalizedMessage) => (message.kind === 'tool_result' && message.toolId === toolId ? message : undefined);
    const history = await fetchCompleteHistory(sessionId, {
      provider: row.provider as LLMProvider,
      projectPath: sessionTranscriptWorkspace(sessionId, row.project_path ?? ''),
      providerSessionId: row.provider_session_id,
    }, (page) => page.some((message) => embeddedResult(message) || independentResult(message)));
    const embedded = history.messages.map(embeddedResult).find(Boolean);
    const independent = history.messages.map(independentResult).find(Boolean);
    const result = embedded ?? (independent ? {
      content: independent.content,
      isError: independent.isError,
      toolUseResult: independent.toolUseResult,
    } : null);
    if (!result) {
      throw new AppError(`Tool result "${toolId}" was not found.`, { code: 'TOOL_RESULT_NOT_FOUND', statusCode: 404 });
    }
    const bounded = boundToolResultDetails(result);
    return { toolId, toolResult: bounded.toolResult, ...(bounded.detailsOmitted ? { toolDetailsOmitted: true } : {}) };
  },

  listArchivedSessions(): ArchivedSessionListItem[] {
    const knownProjects = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    return sessionsDb.getArchivedSessions().map((row) => {
      const projectPath = row.project_path?.trim() ? row.project_path : null;
      let project = null;
      if (projectPath) {
        if (!knownProjects.has(projectPath)) knownProjects.set(projectPath, projectsDb.getProjectPath(projectPath));
        project = knownProjects.get(projectPath) ?? null;
      }
      return {
        sessionId: row.session_id,
        provider: row.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: archivedProjectName(projectPath, project?.custom_project_name),
        sessionTitle: row.custom_name?.trim() || row.session_id,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        lastActivity: row.updated_at ?? row.created_at ?? null,
        isStarred: Boolean(row.isStarred),
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  archiveSessionsIdleFor(olderThanDays: number, options: { dryRun?: boolean; excludeSessionIds?: readonly string[] } = {}): { olderThanDays: number; cutoff: string; matched: number; archived: number; dryRun: boolean; sessions: Array<{ sessionId: string; sessionTitle: string; lastActivity: string | null }> } {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
      throw new AppError('olderThanDays must be a positive number of days.', { code: 'INVALID_RETENTION_WINDOW', statusCode: 400 });
    }
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const excluded = new Set(options.excludeSessionIds ?? []);
    const matches = sessionsDb.getActiveSessionsUpdatedBefore(cutoff).filter(({ session_id }) => !excluded.has(session_id));
    const dryRun = options.dryRun === true;
    if (!dryRun) matches.forEach(({ session_id }) => sessionsDb.updateSessionIsArchived(session_id, true));
    return {
      olderThanDays, cutoff, dryRun,
      matched: matches.length,
      archived: dryRun ? 0 : matches.length,
      sessions: matches.map((row) => ({ sessionId: row.session_id, sessionTitle: row.custom_name?.trim() || row.session_id, lastActivity: row.updated_at ?? row.created_at ?? null })),
    };
  },

  async deleteOrArchiveSessionById(sessionId: string, options: { force?: boolean; deletedFromDisk?: boolean; discardWorktree?: boolean } = {}): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const row = requiredSession(sessionId);
    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return { sessionId, action: 'archived', deletedFromDisk: false };
    }
    // A worktree session's checkout and job ref go with the session; a refusal
    // (running, uncommitted changes) leaves the session in place and says why,
    // unless the caller has already confirmed discarding those changes.
    await releaseWorktreeSession(sessionId, { discardWorktree: options.discardWorktree });
    const deletedFromDisk = options.deletedFromDisk && row.jsonl_path ? await unlinkWhenPresent(row.jsonl_path) : false;
    if (!sessionsDb.deleteSessionById(sessionId)) throw sessionNotFound(sessionId);
    // A quick chat's folder was created for this session alone; without this,
    // every temporary conversation left a directory behind in the workspace root.
    await removeQuickChatWorkspace(sessionId, row.project_path);
    return { sessionId, action: 'deleted', deletedFromDisk };
  },

  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    requiredSession(sessionId);
    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  toggleSessionStarById(sessionId: string): { sessionId: string; isStarred: boolean } {
    const row = requiredSession(sessionId);
    const isStarred = !row.isStarred;
    sessionsDb.updateSessionIsStarred(sessionId, isStarred);
    return { sessionId, isStarred };
  },

  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    requiredSession(sessionId);
    sessionsDb.updateSessionCustomName(sessionId, summary, 'user');
    return { sessionId, summary };
  },

  /**
   * Replaces the stored title with one derived afresh from the transcript. The
   * user asked for it explicitly, so a hand-written name is overwritten here
   * and nowhere else; the indexer never touches a name it did not set.
   */
  async regenerateSessionTitle(sessionId: string): Promise<{ sessionId: string; summary: string }> {
    const row = requiredSession(sessionId);
    const synchronizer = providerRegistry.resolveProvider(row.provider as LLMProvider).sessionSynchronizer;
    if (!row.jsonl_path || !synchronizer.deriveSessionTitle) {
      throw new AppError('This session has no transcript to derive a title from yet.', { code: 'SESSION_TITLE_UNAVAILABLE', statusCode: 409 });
    }
    const summary = await synchronizer.deriveSessionTitle(row.jsonl_path);
    if (!summary) {
      throw new AppError('This session has no message to derive a title from yet.', { code: 'SESSION_TITLE_UNAVAILABLE', statusCode: 409 });
    }
    sessionsDb.updateSessionCustomName(sessionId, summary, 'derived');
    return { sessionId, summary };
  },
};
