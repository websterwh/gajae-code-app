import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Brain, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

type Backend = 'off' | 'local' | 'hindsight';
type Scoping = 'global' | 'per-project' | 'per-project-tagged';

type MemoryView = {
  backend: Backend;
  local: { directory: string; projects: number };
  hindsight: {
    apiUrl: string;
    bankId: string;
    scoping: Scoping;
    autoRecall: boolean;
    autoRetain: boolean;
    hasToken: boolean;
  };
  mempalace: {
    enabled: boolean;
    installed: boolean;
    version: string | null;
    palacePath: string;
    palaceInitialized: boolean;
    hookInstalled: boolean;
    mcpServer: 'enabled' | 'disabled' | 'missing';
  };
};

type ProjectSummary = { projectId: string; path: string; displayName: string };
type ApiEnvelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

const BACKENDS: Backend[] = ['off', 'local', 'hindsight'];
const SCOPINGS: Scoping[] = ['global', 'per-project', 'per-project-tagged'];

const inputClass = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';
const chipClass = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || body.success === false) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  return body.data as T;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Request failed.');

export default function MemorySettingsTab() {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [initialized, setInitialized] = useState<Record<string, boolean>>({});
  const [projectPath, setProjectPath] = useState('');
  const [draft, setDraft] = useState({ apiUrl: '', apiToken: '', bankId: '', scoping: 'per-project-tagged' as Scoping, autoRecall: true, autoRetain: true });
  const [importPath, setImportPath] = useState('');
  const [importMode, setImportMode] = useState('');

  const apply = useCallback((next: MemoryView) => {
    setView(next);
    setDraft({
      apiUrl: next.hindsight.apiUrl,
      apiToken: '',
      bankId: next.hindsight.bankId,
      scoping: next.hindsight.scoping,
      autoRecall: next.hindsight.autoRecall,
      autoRetain: next.hindsight.autoRetain,
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await request<MemoryView>('/api/memory'));
      setError('');
    } catch (loadError) {
      setError(`${t('memory.loadFailed')} ${messageOf(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, [apply, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    void request<{ projects: ProjectSummary[] }>('/api/projects?summary=1')
      .then(async (result) => {
        if (!active) return;
        const list = result.projects.filter((project) => Boolean(project.path?.trim()));
        setProjects(list);
        if (!list.length) return;
        // `mempalace init` leaves mempalace.yaml in the project, so the picker
        // can show which folders are already set up instead of guessing.
        const checked = await request<{ initialized: string[] }>('/api/memory/mempalace/check', {
          method: 'POST',
          body: JSON.stringify({ paths: list.map((project) => project.path) }),
        }).catch(() => ({ initialized: [] as string[] }));
        if (!active) return;
        setInitialized(Object.fromEntries(checked.initialized.map((path) => [path, true])));
      })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, []);

  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'backend' in result) apply(result as MemoryView);
      else await load();
      if (done) setNotice(done);
    } catch (actionError) {
      setError(`${t('memory.actionFailed')} ${messageOf(actionError)}`);
    } finally {
      setBusy(null);
    }
  };

  const choose = (backend: Backend) => {
    if (busy) return;
    void run(`backend:${backend}`, () => request<MemoryView>('/api/memory', {
      method: 'PUT',
      body: JSON.stringify({ provider: backend }),
    }));
  };

  const toggleMempalace = (enabled: boolean) => {
    if (busy) return;
    void run(`mempalace:${enabled ? 'on' : 'off'}`, () => request<MemoryView>('/api/memory', {
      method: 'PUT',
      body: JSON.stringify({ mempalace: enabled }),
    }));
  };

  const saveHindsight = () => {
    void run('hindsight', () => request<MemoryView>('/api/memory', {
      method: 'PUT',
      body: JSON.stringify({
        provider: 'hindsight',
        hindsight: {
          apiUrl: draft.apiUrl,
          apiToken: draft.apiToken,
          bankId: draft.bankId,
          scoping: draft.scoping,
          autoRecall: draft.autoRecall,
          autoRetain: draft.autoRetain,
        },
      }),
    }), t('memory.saved'));
  };

  const initPalace = () => {
    if (!projectPath) {
      setError(t('memory.requiresProject'));
      return;
    }
    void run('init', async () => {
      const result = await request<{ output: string }>('/api/memory/mempalace/init', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      });
      setInitialized((current) => ({ ...current, [projectPath]: true }));
      return result;
    }, t('memory.initDone'));
  };

  const importFiles = () => {
    const target = importPath.trim();
    if (!target) return;
    void run('import', () => request<{ output: string }>('/api/memory/mempalace/import', {
      method: 'POST',
      body: JSON.stringify({ path: target, ...(importMode.trim() ? { mode: importMode.trim() } : {}) }),
    }), t('memory.importDone'));
  };

  const mempalace = view?.mempalace;
  const selectedInitialized = Boolean(projectPath && initialized[projectPath]);
  const providerLabel = (backend: Backend): { title: string; description: string } => ({
    title: t(`memory.${backend}`),
    description: t(`memory.${backend}Description`),
  });

  return (
    <div className="space-y-6">
      <SettingsSection title={t('memory.title')} description={t('memory.description')}>
        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-words">{error}</span>
          </p>
        ) : null}
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}

        <SettingsCard divided>
          {loading ? (
            <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t('memory.loading')}
            </p>
          ) : null}
          {!loading && view ? (
            <div className="grid gap-2 p-4 sm:grid-cols-2" role="radiogroup" aria-label={t('memory.backend')}>
              {BACKENDS.map((backend) => {
                const label = providerLabel(backend);
                const selected = view.backend === backend;
                return (
                  <button
                    key={backend}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy !== null}
                    onClick={() => choose(backend)}
                    className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                      selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                    }`}
                  >
                    <span className={`mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                      selected ? 'border-primary' : 'border-muted-foreground'
                    }`}>
                      {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        {label.title}
                        {selected && busy === `backend:${backend}` ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{label.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </SettingsCard>

        {view ? (
          <SettingsCard divided>
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Brain className="h-3.5 w-3.5" aria-hidden />
                  {t('memory.mempalace')}
                  {mempalace?.enabled ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('memory.mempalaceIndependent')}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{t('memory.mempalaceInstalledOnSelect')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(mempalace?.enabled)}
                aria-label={t('memory.mempalace')}
                className={buttonClass}
                disabled={busy !== null}
                onClick={() => toggleMempalace(!mempalace?.enabled)}
              >
                {busy === 'mempalace:on' || busy === 'mempalace:off' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {mempalace?.enabled ? t('memory.mempalaceDisable') : t('memory.mempalaceEnable')}
              </button>
            </div>
          </SettingsCard>
        ) : null}

        {view?.backend === 'local' ? (
          <SettingsCard>
            <div className="space-y-1 p-4 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('memory.local')}</p>
              <p className="font-mono text-[11px] break-all">{view.local.directory}</p>
              <p>{t('memory.localProjects', { count: view.local.projects })}</p>
            </div>
          </SettingsCard>
        ) : null}

        {view?.backend === 'hindsight' ? (
          <SettingsCard divided>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('memory.hindsightUrl')}
                <input className={`mt-1 ${inputClass}`} value={draft.apiUrl} onChange={(event) => setDraft({ ...draft, apiUrl: event.target.value })} />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {t('memory.hindsightToken')}
                <input className={`mt-1 ${inputClass}`} type="password" autoComplete="off" placeholder={view.hindsight.hasToken ? t('memory.tokenStored') : t('memory.tokenPlaceholder')}
                  value={draft.apiToken} onChange={(event) => setDraft({ ...draft, apiToken: event.target.value })} />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {t('memory.hindsightBank')}
                <input className={`mt-1 ${inputClass}`} value={draft.bankId} onChange={(event) => setDraft({ ...draft, bankId: event.target.value })} />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {t('memory.hindsightScoping')}
                <select className={`mt-1 ${inputClass}`} value={draft.scoping} onChange={(event) => setDraft({ ...draft, scoping: event.target.value as Scoping })}>
                  {SCOPINGS.map((scoping) => <option key={scoping} value={scoping}>{t(`memory.scoping_${scoping.replace(/-/gu, '_')}`)}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={draft.autoRecall} onChange={(event) => setDraft({ ...draft, autoRecall: event.target.checked })} />
                {t('memory.autoRecall')}
              </label>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={draft.autoRetain} onChange={(event) => setDraft({ ...draft, autoRetain: event.target.checked })} />
                {t('memory.autoRetain')}
              </label>
            </div>
            <div className="flex justify-end border-t border-border p-3">
              <button type="button" className={primaryButtonClass} disabled={busy !== null} onClick={saveHindsight}>
                {busy === 'hindsight' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {busy === 'hindsight' ? t('memory.saving') : t('memory.save')}
              </button>
            </div>
          </SettingsCard>
        ) : null}

        {mempalace?.enabled && mempalace ? (
          <>
            <SettingsCard divided>
              <div className="flex flex-wrap gap-2 p-4" role="status" aria-label={t('memory.status')}>
                <span className={chipClass}>
                  {mempalace.installed ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                  {mempalace.installed ? t('memory.installed') : t('memory.missing')}
                  {mempalace.version ? ` · ${mempalace.version}` : ''}
                </span>
                <span className={chipClass}>
                  {mempalace.palaceInitialized ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                  {mempalace.palaceInitialized ? t('memory.palaceReady') : t('memory.palaceEmpty')}
                </span>
                <span className={chipClass}>
                  {mempalace.hookInstalled ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                  {mempalace.hookInstalled ? t('memory.hookReady') : t('memory.hookMissing')}
                </span>
                <span className={chipClass}>
                  {mempalace.mcpServer === 'enabled' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                  {mempalace.mcpServer === 'enabled' ? t('memory.mcpEnabled')
                    : mempalace.mcpServer === 'disabled' ? t('memory.mcpDisabled') : t('memory.mcpMissing')}
                </span>
                <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void load()}>
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden />{t('memory.refresh')}
                </button>
              </div>
              <p className="border-t border-border px-4 py-2 font-mono text-[11px] break-all text-muted-foreground">
                {mempalace.palacePath}
              </p>
              {!mempalace.installed ? (
                <p className="border-t border-border px-4 py-3 text-xs text-destructive">{t('memory.notInstalled')}</p>
              ) : null}
            </SettingsCard>

            <SettingsSection title={t('memory.initTitle')} description={t('memory.initHint')}>
              <SettingsCard>
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
                  <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                    {t('memory.project')}
                    <select className={`mt-1 ${inputClass}`} value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
                      <option value="">{t('memory.selectProject')}</option>
                      {projects.map((project) => (
                        <option key={project.projectId} value={project.path}>
                          {project.displayName}{initialized[project.path] ? ` · ${t('memory.mempalaceInitialized')}` : ''}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[11px] font-normal">{t('memory.mempalaceAutoDetect')}</span>
                  </label>
                  <button type="button" className={primaryButtonClass} disabled={busy !== null || !projectPath} onClick={initPalace}>
                    {busy === 'init' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                    {busy === 'init' ? t('memory.initializing') : selectedInitialized ? t('memory.mempalaceReinit') : t('memory.init')}
                  </button>
                </div>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('memory.importTitle')} description={t('memory.importHint')}>
              <SettingsCard>
                <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
                  <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                    {t('memory.importPath')}
                    <input className={`mt-1 ${inputClass} font-mono`} placeholder="/workspace/project/MEMORY.md" value={importPath} onChange={(event) => setImportPath(event.target.value)} />
                  </label>
                  <label className="w-full text-xs font-medium text-muted-foreground sm:w-36">
                    {t('memory.importMode')}
                    <input className={`mt-1 ${inputClass}`} placeholder="projects" value={importMode} onChange={(event) => setImportMode(event.target.value)} />
                  </label>
                  <button type="button" className={primaryButtonClass} disabled={busy !== null || !importPath.trim()} onClick={importFiles}>
                    {busy === 'import' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                    {busy === 'import' ? t('memory.importing') : t('memory.import')}
                  </button>
                </div>
              </SettingsCard>
            </SettingsSection>
          </>
        ) : null}
      </SettingsSection>
    </div>
  );
}
