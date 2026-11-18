import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../shared/view/ui';
import { browseFilesystemFolders } from '../data/workspaceApi';
import type { FolderSuggestion } from '../types';
import { fuzzyScore } from '../utils/fuzzy';
import { getSuggestionRootPath } from '../utils/pathUtils';

import FolderBrowserModal from './FolderBrowserModal';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  onAdvanceToConfirm: () => void;
};

/**
 * A typed path keeps its prefix behaviour; the fuzzy name score is what lets a
 * fragment find the folder without the parents in front of it. Whichever
 * reading matches better wins, so "proj" ranks a folder named `my-proj` above
 * an unrelated path that merely starts with those letters.
 */
function findSuggestions(path: string, folders: FolderSuggestion[]) {
  const normalizedPath = path.toLowerCase();
  const fragment = normalizedPath.split(/[\\/]/u).pop() ?? '';

  return folders
    .filter((folder) => folder.path.toLowerCase() !== normalizedPath)
    .map((folder) => {
      const byPath = folder.path.toLowerCase().startsWith(normalizedPath) ? 6 : -1;
      const byName = fuzzyScore(fragment, folder.name) ?? -1;
      return { folder, score: Math.max(byPath, byName) };
    })
    .filter(({ score }) => score >= 0)
    .sort((first, second) => second.score - first.score)
    .slice(0, 5)
    .map(({ folder }) => folder);
}

type SuggestionListProps = {
  suggestions: FolderSuggestion[];
  onSelect: (suggestion: FolderSuggestion) => void;
};

function SuggestionList({ suggestions, onSelect }: SuggestionListProps) {
  return (
    <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.path}
          type="button"
          onClick={() => onSelect(suggestion)}
          className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent"
        >
          <div className="text-foreground">{suggestion.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{suggestion.path}</div>
        </button>
      ))}
    </div>
  );
}

export default function WorkspacePathField({
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
}: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([]);
  const [isSuggestionListOpen, setIsSuggestionListOpen] = useState(false);
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);

  useEffect(() => {
    if (value.trim().length <= 2) {
      setSuggestions([]);
      setIsSuggestionListOpen(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const loadSuggestions = async () => {
        try {
          // A bare word is a name, not a path: ask the server to search the
          // workspace root for it so "myproj" finds the folder wherever it is.
          const bareName = !/[\\/]/u.test(value.trim());
          const response = await browseFilesystemFolders(
            bareName ? '' : getSuggestionRootPath(value),
            bareName ? value.trim() : undefined,
          );
          const matches = findSuggestions(value, response.suggestions);
          setSuggestions(matches);
          setIsSuggestionListOpen(matches.length !== 0);
        } catch (reason) {
          console.error('Failed to load path suggestions:', reason);
        }
      };

      void loadSuggestions();
    }, 200);

    return () => window.clearTimeout(timer);
  }, [value]);

  const chooseSuggestion = useCallback((suggestion: FolderSuggestion) => {
    onChange(suggestion.path);
    setIsSuggestionListOpen(false);
  }, [onChange]);

  const chooseFolder = useCallback((path: string, advanceToConfirm: boolean) => {
    onChange(path);
    setIsFolderBrowserOpen(false);
    if (!advanceToConfirm) return;
    onAdvanceToConfirm();
  }, [onAdvanceToConfirm, onChange]);

  const updatePath = useCallback(({ target }: ChangeEvent<HTMLInputElement>) => {
    onChange(target.value);
  }, [onChange]);

  return (
    <>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            type="text"
            value={value}
            onChange={updatePath}
            placeholder={t('projectWizard.step2.existingPlaceholder')}
            className="w-full"
            disabled={disabled}
          />
          {isSuggestionListOpen && suggestions.length > 0 ? (
            <SuggestionList suggestions={suggestions} onSelect={chooseSuggestion} />
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsFolderBrowserOpen(true)}
          className="px-3"
          title={t('projectWizard.folderBrowser.browseFolders')}
          aria-label={t('projectWizard.folderBrowser.browseFolders')}
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
      <FolderBrowserModal
        isOpen={isFolderBrowserOpen}
        autoAdvanceOnSelect={false}
        onClose={() => setIsFolderBrowserOpen(false)}
        onFolderSelected={chooseFolder}
      />
    </>
  );
}
