import { type RefObject, useEffect, useRef, useState } from 'react';

import { useConversationMessageSearch } from '../../command-palette/sources/useSessionMessageSearch';
import { filterSessions, normalizeFilterQuery } from '../utils/sessionFilter';
import type { SidebarProjectListProps } from '../view/SidebarProjectList';

/** Typing pauses this long before the tree re-filters, matching the palette. */
export const FILTER_DEBOUNCE_MS = 150;

const NO_MESSAGE_MATCHES: ReadonlySet<string> = new Set();

type SidebarFilter = {
  query: string;
  setQuery: (value: string) => void;
  /** True once a debounced, non-empty query is being applied. */
  active: boolean;
  /** The list props with the filter applied; identical to the input when inactive. */
  listProps: SidebarProjectListProps;
  /** Sessions left visible by the filter; meaningful only while active. */
  matchCount: number;
  inputRef: RefObject<HTMLInputElement | null>;
};

/**
 * Owns the sidebar filter: the raw query, its debounced copy and the
 * message-body search behind it. Nothing here listens for keystrokes: a
 * document-wide shortcut that pulled focus into this field sent whatever the
 * user typed next into the conversation filter instead of their conversation.
 *
 * While a query is active every matching project is force-expanded so hits in
 * a collapsed project are visible; the user's own expansion state is untouched
 * and returns when the query clears.
 */
export function useSidebarFilter(source: SidebarProjectListProps): SidebarFilter {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!normalizeFilterQuery(query)) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const active = normalizeFilterQuery(debouncedQuery).length > 0;
  // Name matches decide first, and the body search only runs when the query
  // names nothing the user has. A workspace called "server" therefore shows
  // on its own instead of gaining conversations that mention the word a second
  // later, once the server-side search answers.
  const named = filterSessions({
    query: debouncedQuery,
    projects: source.filteredProjects,
    getProjectSessions: source.getProjectSessions,
    messageMatchIds: NO_MESSAGE_MATCHES,
  });
  const searchBodies = active && named.projects.length === 0;
  const messageMatches = useConversationMessageSearch(debouncedQuery, searchBodies);

  const filtered = searchBodies
    ? filterSessions({
      query: debouncedQuery,
      projects: source.filteredProjects,
      getProjectSessions: source.getProjectSessions,
      messageMatchIds: new Set(messageMatches.map((match) => match.sessionId)),
    })
    : named;

  const listProps: SidebarProjectListProps = filtered.active
    ? { ...source, filteredProjects: filtered.projects, getProjectSessions: filtered.sessionsFor, forceExpanded: true }
    : source;

  return { query, setQuery, active: filtered.active, listProps, matchCount: filtered.sessionCount, inputRef };
}
