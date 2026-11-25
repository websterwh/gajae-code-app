import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';

import { api } from '../../../utils/api';

export type MoveFolderSuggestion = { name: string; path: string };

type UseMoveFolderSuggestionsOptions = {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** Where a bare folder name is resolved when the session has no location yet. */
  basePath: string | null;
};

const MOVE_INPUT = /^\/move(?:\s+([^\n]*))?$/u;

/** `/move <partial>` with no newline: the only shape that suggests folders. */
export const moveArgument = (input: string): string | null => {
  const match = MOVE_INPUT.exec(input);
  if (!match) return null;
  return (match[1] ?? '').trim();
};

const trimSlashes = (value: string): string => value.replace(/\/+$/u, '');

const dirnameOf = (value: string): string => {
  const trimmed = trimSlashes(value);
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
};

const basenameOf = (value: string): string => {
  const trimmed = trimSlashes(value);
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
};

/** The directory to list and the name prefix its entries must match. */
export const moveFolderListing = (
  query: string,
  basePath: string | null,
): { directory: string | null; prefix: string } | null => {
  if (!query) return { directory: basePath, prefix: '' };
  if (query.startsWith('/')) return { directory: dirnameOf(query), prefix: basenameOf(query) };
  // `~` is expanded by the browse endpoint, the same way the server resolves
  // the `/move` argument, so it is passed through rather than guessed here.
  if (query.startsWith('~/')) return { directory: dirnameOf(query), prefix: basenameOf(query) };
  if (query.includes('/')) {
    return { directory: `${trimSlashes(basePath ?? '')}/${dirnameOf(query)}`, prefix: basenameOf(query) };
  }
  return { directory: basePath, prefix: query };
};

/**
 * Folder suggestions for `/move`. Directories only, read from the same browse
 * endpoint the project picker uses, so the argument can be chosen instead of
 * remembered. A bare name is looked for under the session's current folder; a
 * path lists the directory its last segment names.
 */
export function useMoveFolderSuggestions({ input, setInput, basePath }: UseMoveFolderSuggestionsOptions) {
  const query = moveArgument(input);
  const [suggestions, setSuggestions] = useState<MoveFolderSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const listing = useMemo(() => (query === null ? null : moveFolderListing(query, basePath)), [basePath, query]);

  useEffect(() => {
    setSelectedIndex(-1);
    setSuggestions([]);
    if (!listing?.directory) return;
    const controller = new AbortController();
    // One keystroke should not become one request; a short pause is enough to
    // keep the list in step with typing.
    const timer = window.setTimeout(() => {
      void api.browseFilesystem(listing.directory ?? null)
        .then(async (response) => {
          if (!response.ok) return [];
          const payload = await response.json() as { suggestions?: Array<{ name?: unknown; path?: unknown; type?: unknown }> };
          return (payload.suggestions ?? [])
            .filter((entry) => entry.type === undefined || entry.type === 'directory')
            .map((entry) => ({ name: String(entry.name ?? ''), path: String(entry.path ?? '') }))
            .filter((entry) => entry.name && entry.path);
        })
        .then((entries) => {
          if (controller.signal.aborted) return;
          const prefix = listing.prefix.toLowerCase();
          setSuggestions(entries
            .filter((entry) => !entry.name.startsWith('.') || prefix.startsWith('.'))
            .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
            .slice(0, 12));
        })
        .catch((error: unknown) => {
          if ((error as { name?: string })?.name !== 'AbortError') setSuggestions([]);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [listing]);

  const showSuggestions = query !== null && suggestions.length > 0;

  const choose = useCallback((suggestion: MoveFolderSuggestion) => {
    setSuggestions([]);
    setSelectedIndex(-1);
    setInput(`/move ${suggestion.path}`);
  }, [setInput]);

  const handleMoveSuggestionsKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!showSuggestions) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % suggestions.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setSuggestions([]);
      setSelectedIndex(-1);
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && selectedIndex >= 0) {
      event.preventDefault();
      choose(suggestions[selectedIndex]);
      return true;
    }
    return false;
  }, [choose, selectedIndex, showSuggestions, suggestions]);

  return {
    showSuggestions,
    suggestions,
    selectedIndex,
    selectSuggestion: choose,
    handleMoveSuggestionsKeyDown,
  };
}
