import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Github, Loader2, Lock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import ErrorBanner from './components/ErrorBanner';
import WorkspacePathField from './components/WorkspacePathField';
import {
  createProjectRequest,
  listGithubRepositories,
  startCloneRequest,
  watchClone,
  type GithubRepository,
} from './data/workspaceApi';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

type Mode = 'folder' | 'github';

/** Same ordering as the server: exact, suffix, substring, description, then subsequence. */
const repositoryScore = (query: string, repository: GithubRepository): number => {
  const needle = query.toLowerCase();
  if (!needle) return 0;
  const name = repository.fullName.toLowerCase();
  if (name === needle) return 100;
  if (name.endsWith(`/${needle}`)) return 90;
  if (name.includes(needle)) return 80;
  if (repository.description.toLowerCase().includes(needle)) return 40;
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const found = name.indexOf(character, cursor);
    if (found === -1) return -1;
    score += found === cursor ? 2 : 1;
    cursor = found + 1;
  }
  return score;
};

/** Filtering happens here, not on the server: typing must never wait on a request. */
const filterRepositories = (repositories: GithubRepository[], query: string): GithubRepository[] => {
  const needle = query.trim();
  if (needle === '') return repositories;
  return repositories
    .map((repository) => ({ repository, score: repositoryScore(needle, repository) }))
    .filter(({ score }) => score >= 0)
    .sort((first, second) => second.score - first.score
      || first.repository.fullName.localeCompare(second.repository.fullName))
    .map(({ repository }) => repository);
};

const tabClass = (active: boolean): string => (
  active
    ? 'flex flex-1 items-center justify-center gap-1.5 rounded-md bg-card px-2 py-1.5 text-xs font-medium text-foreground shadow-sm'
    : 'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground'
);

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('folder');
  const [workspacePath, setWorkspacePath] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repoQuery, setRepoQuery] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GithubRepository | null>(null);
  const [cloneTarget, setCloneTarget] = useState('');
  const [cloneProgress, setCloneProgress] = useState<string | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);

  useEffect(() => () => stopWatching.current?.(), []);

  // The listing is fetched once and filtered in the browser, so a keystroke
  // re-ranks it immediately instead of waiting on GitHub round trips.
  useEffect(() => {
    if (mode !== 'github' || repositories.length > 0) return undefined;
    setLoadingRepos(true);
    void listGithubRepositories('')
      .then(setRepositories)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Repositories could not be loaded.');
      })
      .finally(() => setLoadingRepos(false));
    return undefined;
  }, [mode, repositories.length]);

  const visibleRepositories = useMemo(
    () => filterRepositories(repositories, repoQuery),
    [repositories, repoQuery],
  );

  const createProject = async () => {
    const path = workspacePath.trim();
    if (path === '') {
      setError(t('projectWizard.errors.providePath'));
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const project = await createProjectRequest({ path });
      onProjectCreated?.(project);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('projectWizard.errors.failedToCreate'));
    } finally {
      setIsCreating(false);
    }
  };

  const cloneRepository = async () => {
    if (!selectedRepo) {
      setError('Pick a repository first.');
      return;
    }
    const target = cloneTarget.trim();
    if (target === '') {
      setError(t('projectWizard.errors.providePath'));
      return;
    }

    setIsCreating(true);
    setError(null);
    setCloneProgress(`Cloning ${selectedRepo.fullName}…`);
    try {
      const cloneId = await startCloneRequest({ path: target, githubUrl: selectedRepo.cloneUrl });
      stopWatching.current = watchClone(cloneId, {
        onProgress: (message) => setCloneProgress(message),
        onComplete: (project) => {
          stopWatching.current?.();
          onProjectCreated?.(project);
          onClose();
        },
        onError: (message) => {
          stopWatching.current?.();
          setCloneProgress(null);
          setIsCreating(false);
          setError(message);
        },
      });
    } catch (reason) {
      setCloneProgress(null);
      setIsCreating(false);
      setError(reason instanceof Error ? reason.message : 'The clone could not be started.');
    }
  };

  const pathIsEmpty = !workspacePath.trim();

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-background/80 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <FolderPlus className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 id="add-project-title" className="text-base font-semibold text-foreground">
                {t('projectWizard.addProject')}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('projectWizard.addProjectDescription')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('projectWizard.buttons.cancel')}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
            <button type="button" className={tabClass(mode === 'folder')} onClick={() => setMode('folder')}>
              <FolderPlus className="size-3" />
              Existing folder
            </button>
            <button type="button" className={tabClass(mode === 'github')} onClick={() => setMode('github')}>
              <Github className="size-3" />
              GitHub repository
            </button>
          </div>

          {error && <ErrorBanner message={error} />}

          {mode === 'folder' ? (
            <>
              <label className="block text-xs font-medium text-foreground">
                {t('projectWizard.step2.existingPath')}
              </label>
              <WorkspacePathField
                value={workspacePath}
                disabled={isCreating}
                onChange={setWorkspacePath}
                onAdvanceToConfirm={() => {}}
              />
            </>
          ) : (
            <>
              <input
                autoFocus
                value={repoQuery}
                onChange={(event) => setRepoQuery(event.target.value)}
                disabled={isCreating}
                placeholder="Search your repositories"
                aria-label="Search GitHub repositories"
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />

              <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
                {loadingRepos ? (
                  <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    Loading repositories…
                  </p>
                ) : null}
                {!loadingRepos && visibleRepositories.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    {repositories.length === 0
                      ? 'No repositories loaded. Save a GitHub token in Git settings if you have not already.'
                      : 'No repositories matched that search.'}
                  </p>
                ) : null}
                {visibleRepositories.map((repository) => (
                  <button
                    key={repository.fullName}
                    type="button"
                    disabled={isCreating}
                    onClick={() => setSelectedRepo(repository)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted ${
                      selectedRepo?.fullName === repository.fullName ? 'bg-muted' : ''
                    }`}
                  >
                    {repository.private ? <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{repository.fullName}</span>
                      {repository.description ? (
                        <span className="block truncate text-muted-foreground">{repository.description}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>

              {selectedRepo ? (
                <>
                  <label className="block text-xs font-medium text-foreground">
                    Clone {selectedRepo.name} into
                  </label>
                  <WorkspacePathField
                    value={cloneTarget}
                    disabled={isCreating}
                    onChange={setCloneTarget}
                    onAdvanceToConfirm={() => {}}
                  />
                </>
              ) : null}

              {cloneProgress ? (
                <p role="status" className="text-xs text-muted-foreground">{cloneProgress}</p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isCreating}>
            {t('projectWizard.buttons.cancel')}
          </Button>
          {mode === 'folder' ? (
            <Button type="button" onClick={createProject} disabled={pathIsEmpty || isCreating}>
              {isCreating && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isCreating
                ? t('projectWizard.buttons.creating')
                : t('projectWizard.addButton')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={cloneRepository}
              disabled={!selectedRepo || !cloneTarget.trim() || isCreating}
            >
              {isCreating && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isCreating ? 'Cloning…' : 'Clone repository'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
