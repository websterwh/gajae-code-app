import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

export type SessionFilterInput = {
  query: string;
  projects: Project[];
  getProjectSessions: (project: Project) => SessionWithProvider[];
  /**
   * Sessions whose message bodies matched, from the server-side search. Used
   * only when no project name or session title matches the query.
   */
  messageMatchIds: ReadonlySet<string>;
};

export type SessionFilterResult = {
  /** Trimmed, lower-cased query; empty when the filter is inactive. */
  needle: string;
  active: boolean;
  projects: Project[];
  sessionsFor: (project: Project) => SessionWithProvider[];
  sessionCount: number;
};

export const normalizeFilterQuery = (query: string): string => query.trim().toLocaleLowerCase();

const sessionTitle = (session: SessionWithProvider): string => String(session.summary || session.name || session.title || '');

const contains = (haystack: string, needle: string) => haystack.toLocaleLowerCase().includes(needle);

/**
 * Narrows the project tree to what matches the query.
 *
 * A name match - the project's own name or a session title - wins outright.
 * Conversation bodies are only consulted when the query names nothing the
 * user has, so searching a workspace called "server" does not keep pulling in
 * conversations that merely mention the word. A project whose name matches
 * keeps all of its sessions, since the user is evidently looking for the
 * project. Projects with nothing left to show are dropped entirely.
 */
export function filterSessions({ query, projects, getProjectSessions, messageMatchIds }: SessionFilterInput): SessionFilterResult {
  const needle = normalizeFilterQuery(query);
  if (!needle) {
    return { needle, active: false, projects, sessionsFor: getProjectSessions, sessionCount: 0 };
  }

  const named = new Map<string, SessionWithProvider[]>();
  const namedProjects: Project[] = [];
  let namedCount = 0;
  for (const project of projects) {
    const sessions = getProjectSessions(project);
    const projectMatches = contains(project.displayName || project.projectId, needle);
    const matching = projectMatches
      ? sessions
      : sessions.filter((session) => contains(sessionTitle(session), needle));
    if (!projectMatches && matching.length === 0) continue;
    named.set(project.projectId, matching);
    namedProjects.push(project);
    namedCount += matching.length;
  }
  if (namedProjects.length > 0) {
    return {
      needle,
      active: true,
      projects: namedProjects,
      sessionsFor: (project) => named.get(project.projectId) ?? [],
      sessionCount: namedCount,
    };
  }

  const bodied = new Map<string, SessionWithProvider[]>();
  const bodiedProjects: Project[] = [];
  let bodiedCount = 0;
  for (const project of projects) {
    const matching = getProjectSessions(project).filter((session) => messageMatchIds.has(session.id));
    if (matching.length === 0) continue;
    bodied.set(project.projectId, matching);
    bodiedProjects.push(project);
    bodiedCount += matching.length;
  }

  return {
    needle,
    active: true,
    projects: bodiedProjects,
    sessionsFor: (project) => bodied.get(project.projectId) ?? [],
    sessionCount: bodiedCount,
  };
}
