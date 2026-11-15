import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, Loader2, Pencil, Pin, Plus, RefreshCw, Search, Server, Trash2, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type McpTransport = 'stdio' | 'http' | 'sse';
type McpScope = 'global' | 'project';

type InstallState = {
  version: string | null;
  status: 'installed' | 'failed';
  error?: string;
  pin?: string | null;
  installedAt?: string;
  lastAttempt?: { status: 'installed' | 'failed'; at: string; error?: string };
};

type McpServer = {
  name: string;
  transport: McpTransport;
  scope: McpScope;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  envIsSet: Record<string, boolean>;
  headers: Record<string, string>;
  headersIsSet: Record<string, boolean>;
  pin: string | null;
  pinnable: boolean;
  packageName: string | null;
  install: InstallState | null;
};

type CatalogEnv = { name: string; required?: boolean; secret?: boolean; description?: string };
type CatalogEntry = {
  name: string;
  title?: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: CatalogEnv[];
  requires?: { mounts?: Array<{ path: string; purpose?: string }> };
  package?: { manager: string; name: string };
  stars?: number;
  source: 'bundled' | 'overlay' | 'registry';
};

type CatalogCounts = Record<CatalogEntry['source'], number>;
type CatalogSort = 'name' | 'relevance' | 'popularity';
type ProjectSummary = { projectId: string; path: string; displayName: string };

type VerifyResult = { ok: boolean; toolCount?: number; tools?: string[]; error?: string };

type StatusData = {
  provisioning: { running: boolean; current?: { manager: string; package: string } } | null;
  inFlight: boolean;
  failed: Array<{ manager: string; name: string; entry: { error?: string } }>;
  ledger: Record<string, Record<string, InstallState>>;
  missingMounts: Array<{ server: string; path: string; purpose?: string; composeLine: string }>;
};

type ApiEnvelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

const inputClass = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';
const chipClass = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || body.success === false) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  return body.data as T;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await authenticatedFetch(path, init);
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as ApiEnvelope<unknown>;
  throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
}

const parseLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);

function parsePairs(value: string, separator: '=' | ':'): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of parseLines(value)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const entry = line.slice(index + 1).trim();
    if (key && entry) pairs[key] = entry;
  }
  return pairs;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Request failed.';

const formatStars = (stars: number): string => (stars >= 1000
  ? `★ ${(stars / 1000).toFixed(1).replace(/\.0$/u, '')}k`
  : `★ ${stars}`);

const sourceLabelKey = (source: CatalogEntry['source']): string => (
  source === 'bundled' ? 'mcp.sourceBundled' : source === 'overlay' ? 'mcp.sourceOverlay' : 'mcp.sourceRegistry'
);

export default function McpSettingsTab() {
  const { t } = useTranslation('settings');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [catalogCounts, setCatalogCounts] = useState<CatalogCounts>({ bundled: 0, overlay: 0, registry: 0 });
  const [openNotice, setOpenNotice] = useState<'warning' | 'registry' | null>(null);
  const [requirements, setRequirements] = useState<Record<string, CatalogEnv[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<McpScope>('global');
  const [projectPath, setProjectPath] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState<CatalogSort>('name');
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
  const [pinDrafts, setPinDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({
    command: '', args: '', url: '', env: '', headers: '', requiredEnv: {} as Record<string, string>,
  });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manual, setManual] = useState({
    name: '', transport: 'stdio' as McpTransport, command: '', args: '', url: '', env: '', headers: '',
  });

  const projectQuery = scope === 'project' && projectPath ? `&projectPath=${encodeURIComponent(projectPath)}` : '';
  const listPath = `/api/mcp/servers?scope=${scope === 'project' ? 'all' : 'global'}${projectQuery}`;
  const statusPath = `/api/mcp/status${projectQuery ? `?${projectQuery.slice(1)}` : ''}`;
  const projectReady = scope !== 'project' || Boolean(projectPath);

  const rememberRequirements = useCallback((entries: CatalogEntry[]) => {
    setRequirements((current) => {
      const next = { ...current };
      for (const entry of entries) {
        if (!entry.env?.length) continue;
        next[entry.name] = entry.env;
        if (entry.package?.name) next[`pkg:${entry.package.name}`] = entry.env;
      }
      return next;
    });
  }, []);

  const requirementsFor = useCallback((server: McpServer): CatalogEnv[] => (
    requirements[server.name] ?? (server.packageName ? requirements[`pkg:${server.packageName}`] ?? [] : [])
  ), [requirements]);

  const reload = useCallback(async (): Promise<McpServer[]> => {
    setLoading(true);
    try {
      const [nextServers, nextStatus] = await Promise.all([
        request<McpServer[]>(listPath),
        request<StatusData>(statusPath),
      ]);
      setServers(nextServers);
      setStatus(nextStatus);
      setError('');
      return nextServers;
    } catch (loadError) {
      setError(messageOf(loadError));
      return [];
    } finally {
      setLoading(false);
    }
  }, [listPath, statusPath]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (scope !== 'project' || projects.length > 0) return;
    setProjectsLoading(true);
    void request<{ projects: ProjectSummary[] }>('/api/projects?summary=1')
      .then((result) => setProjects(result.projects.filter((project) => Boolean(project.path?.trim()))))
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoading(false));
  }, [projects.length, scope]);

  // Required variables come from the curated layer, so a reloaded installed
  // row can still say what it needs without a registry request.
  useEffect(() => {
    void request<{ entries: CatalogEntry[] }>('/api/mcp/catalog?source=bundled')
      .then((result) => rememberRequirements(result.entries))
      .catch(() => undefined);
  }, [rememberRequirements]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (source) params.set('source', source);
      if (!search.trim()) params.set('sort', sort);
      void request<{ entries: CatalogEntry[]; warning?: string; registryError?: string; counts: CatalogCounts }>(`/api/mcp/catalog?${params.toString()}`)
        .then((result) => {
          setCatalog(result.entries);
          setCatalogWarning(result.warning ?? null);
          setRegistryError(result.registryError ?? null);
          if (result.counts) setCatalogCounts(result.counts);
          rememberRequirements(result.entries);
        })
        .catch((catalogError) => setError(messageOf(catalogError)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [rememberRequirements, search, sort, source]);

  const serverPath = (server: McpServer, suffix = ''): string => {
    const params = new URLSearchParams({ scope: server.scope });
    if (server.scope === 'project') params.set('projectPath', projectPath);
    return `/api/mcp/servers/${encodeURIComponent(server.name)}${suffix}?${params.toString()}`;
  };

  const toggle = async (server: McpServer) => {
    const enabled = !server.enabled;
    setServers((current) => current.map((entry) => entry.name === server.name ? { ...entry, enabled } : entry));
    try {
      await request(serverPath(server), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      setServers((current) => current.map((entry) => entry.name === server.name ? { ...entry, enabled: server.enabled } : entry));
      setError(t('mcp.toggleFailed'));
    }
  };

  const verify = async (server: McpServer) => {
    setVerifying(server.name);
    setError('');
    try {
      const result = await request<VerifyResult>(serverPath(server, '/verify'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      setVerifyResults((current) => ({ ...current, [server.name]: result }));
    } catch (verifyError) {
      setVerifyResults((current) => ({ ...current, [server.name]: { ok: false, error: messageOf(verifyError) } }));
    } finally {
      setVerifying(null);
    }
  };

  const setPin = async (server: McpServer, version: string) => {
    setBusy(`pin:${server.name}`);
    setError('');
    try {
      await request(serverPath(server, '/pin'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: version.trim() || null }),
      });
      setPinDrafts((current) => ({ ...current, [server.name]: '' }));
      await reload();
    } catch (pinError) {
      setError(messageOf(pinError));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: McpServer) => {
    setBusy(`remove:${server.name}`);
    setError('');
    try {
      await requestVoid(serverPath(server), { method: 'DELETE' });
      setConfirmRemove(null);
      await reload();
    } catch (removeError) {
      setError(`${t('mcp.removeFailed')} ${messageOf(removeError)}`);
    } finally {
      setBusy(null);
    }
  };

  const beginEdit = (server: McpServer) => {
    setEditing(server.name);
    setEditDraft({
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      env: '',
      headers: '',
      requiredEnv: {},
    });
  };

  const saveEdit = async (server: McpServer) => {
    setBusy(`edit:${server.name}`);
    setError('');
    try {
      const patch: Record<string, unknown> = {};
      if (server.transport === 'stdio') {
        patch.command = editDraft.command.trim();
        patch.args = parseLines(editDraft.args);
      } else {
        patch.url = editDraft.url.trim();
      }
      const configured = Object.fromEntries(Object.entries(editDraft.requiredEnv).filter(([, value]) => value.trim()));
      const env = { ...parsePairs(editDraft.env, '='), ...configured };
      if (Object.keys(env).length) patch.env = env;
      const headers = parsePairs(editDraft.headers, ':');
      if (Object.keys(headers).length) patch.headers = headers;
      await request(serverPath(server), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setEditing(null);
      await reload();
    } catch (editError) {
      setError(`${t('mcp.saveFailed')} ${messageOf(editError)}`);
    } finally {
      setBusy(null);
    }
  };

  const installEntry = async (entry: CatalogEntry) => {
    if (!projectReady) return;
    setBusy(`install:${entry.name}`);
    setError('');
    try {
      await request('/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: entry.name,
          transport: entry.transport,
          ...(entry.command ? { command: entry.command } : {}),
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.url ? { url: entry.url } : {}),
          scope,
          ...(scope === 'project' ? { projectPath } : {}),
        }),
      });
      rememberRequirements([entry]);
      const next = await reload();
      setRecentlyAdded(entry.name);
      const installed = next.find((server) => server.name === entry.name);
      if (installed && (entry.env ?? []).some((variable) => variable.required)) beginEdit(installed);
    } catch (installError) {
      // Installing a name that already exists is a configuration step, not an
      // error the user has to translate.
      if (/already exists/iu.test(messageOf(installError))) {
        const next = await reload();
        const installed = next.find((server) => server.name === entry.name);
        if (installed) beginEdit(installed);
      } else {
        setError(`${t('mcp.installFailed')} ${messageOf(installError)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const manualValid = Boolean(manual.name.trim())
    && (manual.transport === 'stdio' ? Boolean(manual.command.trim()) : Boolean(manual.url.trim()))
    && projectReady;

  const addManual = async () => {
    if (!manualValid) return;
    setBusy('manual');
    setManualError('');
    try {
      const env = parsePairs(manual.env, '=');
      const headers = parsePairs(manual.headers, ':');
      const name = manual.name.trim();
      await request('/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          transport: manual.transport,
          ...(manual.transport === 'stdio'
            ? { command: manual.command.trim(), args: parseLines(manual.args) }
            : { url: manual.url.trim() }),
          ...(Object.keys(env).length ? { env } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          scope,
          ...(scope === 'project' ? { projectPath } : {}),
        }),
      });
      setManual({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '', headers: '' });
      setManualError('');
      setManualOpen(false);
      await reload();
      setRecentlyAdded(name);
    } catch (addError) {
      setManualError(`${t('mcp.installFailed')} ${messageOf(addError)}`);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNote(t('mcp.copied'));
    } catch {
      setCopyNote(null);
    }
  };

  const ledgerRows = status
    ? Object.entries(status.ledger).flatMap(([manager, entries]) => Object.entries(entries).map(([name, entry]) => ({ manager, name, entry })))
    : [];
  const lastLedgerUpdate = ledgerRows
    .map((row) => row.entry.lastAttempt?.at ?? row.entry.installedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const selectedProject = projects.find((project) => project.path === projectPath);

  const sourceDescription = source === 'bundled' ? t('mcp.sourceBundledDesc')
    : source === 'overlay' ? t('mcp.sourceOverlayDesc')
      : source === 'registry' ? t('mcp.sourceRegistryDesc')
        : t('mcp.sourceAllDesc');

  return (
    <div className="space-y-6">
      <SettingsSection title={t('mcp.title')} description={t('mcp.description')}>
        <div className="rounded-xl border border-border bg-card/50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2" role="status" aria-label={t('mcp.statusTitle')}>
            <span className={chipClass}>
              {status?.inFlight ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3 w-3" aria-hidden />}
              {status?.inFlight ? t('mcp.statusRunning') : t('mcp.statusIdle')}
              {status?.provisioning?.current ? ` · ${status.provisioning.current.manager}: ${status.provisioning.current.package}` : ''}
            </span>
            <span className={chipClass}>{t('mcp.failedCount', { count: status?.failed.length ?? 0 })}</span>
            <span className={chipClass}>{t('mcp.missingCount', { count: status?.missingMounts.length ?? 0 })}</span>
            <span className={chipClass}>
              {t('mcp.ledgerCount', { count: ledgerRows.length })}
              {lastLedgerUpdate ? ` · ${new Date(lastLedgerUpdate).toLocaleDateString()}` : ''}
            </span>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t('mcp.statusDetails')}</summary>
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <div>
                <h4 className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('mcp.failedInstalls')}
                </h4>
                {(status?.failed ?? []).length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">{t('mcp.noFailedInstalls')}</p>
                ) : (status?.failed ?? []).map((failure) => (
                  <p key={`${failure.manager}:${failure.name}`} className="mt-1 text-xs text-destructive">
                    {failure.manager} · {failure.name}: {failure.entry.error ?? ''}
                  </p>
                ))}
              </div>
              <div>
                <h4 className="text-xs font-medium text-foreground">{t('mcp.missingMounts')}</h4>
                {(status?.missingMounts ?? []).length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">{t('mcp.noMissingMounts')}</p>
                ) : (status?.missingMounts ?? []).map((mount) => (
                  <div key={`${mount.server}:${mount.path}`} className="mt-2 rounded-lg border border-border p-2">
                    <p className="text-xs text-muted-foreground">{mount.server} · {mount.path}{mount.purpose ? ` — ${mount.purpose}` : ''}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="block min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{mount.composeLine}</code>
                      <button type="button" className={buttonClass} onClick={() => void copy(mount.composeLine)}>
                        <Copy className="h-3.5 w-3.5" aria-hidden />{t('mcp.copy')}
                      </button>
                    </div>
                  </div>
                ))}
                {copyNote && <p role="status" className="mt-2 text-xs text-muted-foreground">{copyNote}</p>}
              </div>
              <div>
                <h4 className="text-xs font-medium text-foreground">{t('mcp.ledger')}</h4>
                {ledgerRows.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">{t('mcp.noLedger')}</p>
                ) : ledgerRows.map((row) => (
                  <p key={`${row.manager}:${row.name}`} className="mt-1 text-xs text-muted-foreground">
                    {row.manager} · {row.name} · {row.entry.version ?? '—'} · {row.entry.status}
                    {row.entry.pin ? ` · ${t('mcp.pinnedTo', { version: row.entry.pin })}` : ''}
                  </p>
                ))}
              </div>
            </div>
          </details>
        </div>

        <SettingsCard>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <label className="min-w-40 flex-1 text-xs font-medium text-muted-foreground">
              {t('mcp.scope')}
              <select
                aria-label={t('mcp.scope')}
                value={scope}
                onChange={(event) => {
                  const next = event.target.value === 'project' ? 'project' : 'global';
                  setScope(next);
                  if (next === 'global') setProjectPath('');
                }}
                className={`mt-1 ${inputClass}`}
              >
                <option value="global">{t('mcp.scopeGlobal')}</option>
                <option value="project">{t('mcp.scopeProject')}</option>
              </select>
            </label>
            {scope === 'project' && (
              <label className="min-w-48 flex-1 text-xs font-medium text-muted-foreground">
                {t('mcp.projectPath')}
                <select
                  aria-label={t('mcp.projectPath')}
                  className={`mt-1 ${inputClass}`}
                  value={projectPath}
                  disabled={projectsLoading}
                  onChange={(event) => setProjectPath(event.target.value)}
                >
                  <option value="">{t('mcp.selectProject')}</option>
                  {projects.map((project) => (
                    <option key={project.projectId} value={project.path}>{project.displayName}</option>
                  ))}
                </select>
                {selectedProject && (
                  <span className="mt-1 block truncate font-mono text-[11px] font-normal">{selectedProject.path}</span>
                )}
                {!projectsLoading && projects.length === 0 && (
                  <span className="mt-1 block font-normal">{t('mcp.noProjects')} {t('mcp.noProjectsHint')}</span>
                )}
              </label>
            )}
            <button type="button" className={`${buttonClass} h-9`} onClick={() => setManualOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{t('mcp.manuallyAdd')}
            </button>
          </div>
          {error && <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground" role="status">{t('mcp.installed')}: {servers.length}</p>
            <button type="button" className={buttonClass} onClick={() => void reload()} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />{t('mcp.refresh')}
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mcp.installed')}>
        <SettingsCard divided>
          {!loading && servers.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('mcp.installedEmpty')}</p>
          )}
          {servers.map((server) => {
            const result = verifyResults[server.name];
            const install = server.install;
            const requiredVars = requirementsFor(server);
            const missingRequired = requiredVars.filter((variable) => variable.required && !server.envIsSet[variable.name]);
            return (
              <div key={`${server.scope}:${server.name}`} className={`p-4 ${recentlyAdded === server.name ? 'bg-primary/5' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      <Server className="h-4 w-4" aria-hidden />
                      <span className="truncate">{server.name}</span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
                        {t(`mcp.transport${server.transport === 'stdio' ? 'Stdio' : server.transport === 'http' ? 'Http' : 'Sse'}`)}
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
                        {t(server.scope === 'project' ? 'mcp.scopeProject' : 'mcp.scopeGlobal')}
                      </span>
                      {missingRequired.length > 0 && (
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
                          {t('mcp.needsConfiguration')}
                        </span>
                      )}
                      {recentlyAdded === server.name && (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] tracking-wide text-primary uppercase">
                          {t('mcp.newBadge')}
                        </span>
                      )}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {server.packageName ?? server.url ?? server.command ?? ''}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('mcp.version')}: {install?.version ?? t('mcp.notInstalled')}
                      {install?.status === 'failed' ? ` · ${t('mcp.failed')}` : ''}
                      {server.pin ? ` · ${t('mcp.pinnedTo', { version: server.pin })}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <SettingsToggle
                      checked={server.enabled}
                      onChange={() => void toggle(server)}
                      ariaLabel={`${server.enabled ? t('mcp.enabled') : t('mcp.disabled')}: ${server.name}`}
                    />
                    <button type="button" className={buttonClass} aria-busy={verifying === server.name}
                      disabled={verifying === server.name} onClick={() => void verify(server)}>
                      {verifying === server.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                      {verifying === server.name ? t('mcp.verifying') : t('mcp.verify')}
                    </button>
                    <button type="button" className={buttonClass} onClick={() => beginEdit(server)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />{t('mcp.configure')}
                    </button>
                    {confirmRemove === server.name ? (
                      <button type="button" className={`${buttonClass} border-destructive text-destructive`}
                        disabled={busy === `remove:${server.name}`} onClick={() => void remove(server)}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('mcp.confirmRemove')}
                      </button>
                    ) : (
                      <button type="button" className={buttonClass} onClick={() => setConfirmRemove(server.name)}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('mcp.remove')}
                      </button>
                    )}
                  </div>
                </div>
                {result && (
                  <p role="status" className={`mt-2 text-xs ${result.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
                    {result.ok
                      ? t('mcp.verifiedTools', { count: result.toolCount ?? 0 })
                      : `${t('mcp.verifyFailed')}: ${result.error ?? ''}`}
                  </p>
                )}
                {/* A remote server has no package version, so the pin control is
                    absent rather than disabled with nothing to lock. */}
                {server.pinnable && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Pin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <input
                      aria-label={t('mcp.pin')}
                      className={`${inputClass} sm:w-40`}
                      placeholder={t('mcp.pinPlaceholder')}
                      value={pinDrafts[server.name] ?? ''}
                      onChange={(event) => setPinDrafts((current) => ({ ...current, [server.name]: event.target.value }))}
                    />
                    <button type="button" className={buttonClass} disabled={busy === `pin:${server.name}`}
                      onClick={() => void setPin(server, pinDrafts[server.name] ?? '')}>
                      {t('mcp.pin')}
                    </button>
                    {server.pin && (
                      <button type="button" className={buttonClass} disabled={busy === `pin:${server.name}`}
                        onClick={() => void setPin(server, '')}>
                        {t('mcp.unpin')}
                      </button>
                    )}
                  </div>
                )}
                {editing === server.name && (
                  <div className="mt-3 grid gap-2 rounded-lg border border-border p-3">
                    {missingRequired.length > 0 && (
                      <div className="grid gap-2">
                        <p className="text-xs font-medium text-foreground">{t('mcp.requiredEnv')}</p>
                        {missingRequired.map((variable, index) => (
                          <label key={variable.name} className="text-xs text-muted-foreground">
                            {variable.name} *
                            <input
                              className={`mt-1 ${inputClass}`}
                              type={variable.secret ? 'password' : 'text'}
                              autoComplete="off"
                              autoFocus={index === 0}
                              placeholder={t('mcp.requiredEnvPlaceholder')}
                              value={editDraft.requiredEnv[variable.name] ?? ''}
                              onChange={(event) => setEditDraft((current) => ({
                                ...current,
                                requiredEnv: { ...current.requiredEnv, [variable.name]: event.target.value },
                              }))}
                            />
                            {variable.description && <span className="mt-1 block font-normal">{variable.description}</span>}
                          </label>
                        ))}
                      </div>
                    )}
                    {server.transport === 'stdio' ? (
                      <>
                        <label className="text-xs text-muted-foreground">
                          {t('mcp.command')}
                          <input className={`mt-1 ${inputClass}`} value={editDraft.command}
                            onChange={(event) => setEditDraft((current) => ({ ...current, command: event.target.value }))} />
                        </label>
                        <label className="text-xs text-muted-foreground">
                          {t('mcp.args')}
                          <textarea className={`mt-1 ${inputClass}`} rows={3} value={editDraft.args}
                            onChange={(event) => setEditDraft((current) => ({ ...current, args: event.target.value }))} />
                        </label>
                      </>
                    ) : (
                      <label className="text-xs text-muted-foreground">
                        {t('mcp.url')}
                        <input className={`mt-1 ${inputClass}`} value={editDraft.url}
                          onChange={(event) => setEditDraft((current) => ({ ...current, url: event.target.value }))} />
                      </label>
                    )}
                    <label className="text-xs text-muted-foreground">
                      {t('mcp.env')} · {t('mcp.envKeep')}
                      <textarea className={`mt-1 ${inputClass}`} rows={2} placeholder="KEY=value"
                        value={editDraft.env}
                        onChange={(event) => setEditDraft((current) => ({ ...current, env: event.target.value }))} />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      {t('mcp.headers')}
                      <textarea className={`mt-1 ${inputClass}`} rows={2} placeholder="Authorization: Bearer …"
                        value={editDraft.headers}
                        onChange={(event) => setEditDraft((current) => ({ ...current, headers: event.target.value }))} />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button type="button" className={buttonClass} onClick={() => setEditing(null)}>{t('mcp.cancel')}</button>
                      <button type="button" className={primaryButtonClass} disabled={busy === `edit:${server.name}`}
                        onClick={() => void saveEdit(server)}>{t('mcp.save')}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mcp.findTitle')} description={t('mcp.findDescription')}>
        <SettingsCard divided>
          <div className="grid gap-2 p-4 sm:grid-cols-3">
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.findTitle')}
              <span className="relative mt-1 block">
                <Search className="pointer-events-none absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" aria-hidden />
                <input className={`${inputClass} pl-8`} value={search} placeholder={t('mcp.searchPlaceholder')}
                  onChange={(event) => setSearch(event.target.value)} />
              </span>
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.source')}
              <select aria-label={t('mcp.source')} className={`mt-1 ${inputClass}`} value={source}
                onChange={(event) => setSource(event.target.value)}>
                <option value="">{t('mcp.sourceAll')} ({catalogCounts.bundled + catalogCounts.overlay + catalogCounts.registry})</option>
                <option value="bundled">{t('mcp.sourceBundled')} ({catalogCounts.bundled})</option>
                <option value="overlay">{t('mcp.sourceOverlay')} ({catalogCounts.overlay})</option>
                <option value="registry">{t('mcp.sourceRegistry')} ({catalogCounts.registry})</option>
              </select>
              <span className="mt-1 block font-normal">{sourceDescription}</span>
              {source === 'registry' && <span className="mt-1 block font-normal">{t('mcp.registryNote')}</span>}
            </label>
            {!search.trim() && (
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.sort')}
                <select aria-label={t('mcp.sort')} className={`mt-1 ${inputClass}`} value={sort}
                  onChange={(event) => setSort(event.target.value as CatalogSort)}>
                  <option value="name">{t('mcp.sortName')}</option>
                  <option value="relevance">{t('mcp.sortRelevance')}</option>
                  <option value="popularity">{t('mcp.sortPopularity')}</option>
                </select>
              </label>
            )}
          </div>
          {(catalogWarning || registryError) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
              {catalogWarning && (
                <button type="button" className={chipClass}
                  aria-expanded={openNotice === 'warning'}
                  onClick={() => setOpenNotice((current) => current === 'warning' ? null : 'warning')}>
                  {t('mcp.bundledOnly')}
                </button>
              )}
              {registryError && (
                <button type="button" className={chipClass}
                  aria-expanded={openNotice === 'registry'}
                  onClick={() => setOpenNotice((current) => current === 'registry' ? null : 'registry')}>
                  {t('mcp.registryUnavailable')}
                </button>
              )}
            </div>
          )}
          {openNotice === 'warning' && catalogWarning && (
            <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{catalogWarning}</p>
          )}
          {openNotice === 'registry' && registryError && (
            <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{registryError}</p>
          )}
          {!projectReady && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('mcp.projectRequired')}</p>
          )}
          {catalog.length === 0 && (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{t('mcp.noResults')}</p>
          )}
          {catalog.map((entry) => {
            const installed = servers.find((server) => server.name === entry.name);
            const isBusy = busy === `install:${entry.name}`;
            return (
              <div key={`${entry.source}:${entry.name}`}
                className={`border-t border-border p-4 ${recentlyAdded === entry.name ? 'bg-primary/5' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      {entry.title ?? entry.name}
                      {entry.stars !== undefined && (
                        <span className="text-[11px] font-normal text-muted-foreground">{formatStars(entry.stars)}</span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                    <p className="mt-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                      {entry.transport} · {t(sourceLabelKey(entry.source))}
                      {entry.package?.manager ? ` · ${entry.package.manager}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {installed ? (
                      <>
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
                          {t('mcp.installedBadge')}
                        </span>
                        <button type="button" className={buttonClass} onClick={() => beginEdit(installed)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />{t('mcp.configure')}
                        </button>
                        <button type="button" className={buttonClass} disabled={verifying === installed.name}
                          onClick={() => void verify(installed)}>
                          {verifying === installed.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                          {t('mcp.verify')}
                        </button>
                        {confirmRemove === installed.name ? (
                          <button type="button" className={`${buttonClass} border-destructive text-destructive`}
                            disabled={busy === `remove:${installed.name}`} onClick={() => void remove(installed)}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('mcp.confirmRemove')}
                          </button>
                        ) : (
                          <button type="button" className={buttonClass} onClick={() => setConfirmRemove(installed.name)}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('mcp.remove')}
                          </button>
                        )}
                      </>
                    ) : (
                      <button type="button" className={primaryButtonClass} disabled={isBusy || !projectReady}
                        onClick={() => void installEntry(entry)}>
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                        {isBusy ? t('mcp.installing') : t('mcp.install')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <Dialog open={manualOpen} onOpenChange={(open) => { setManualOpen(open); if (!open) setManualError(''); }}>
        <DialogContent
          aria-labelledby="mcp-manual-dialog-title"
          className="flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-lg flex-col overflow-hidden rounded-2xl p-0"
        >
          <DialogTitle id="mcp-manual-dialog-title">{t('mcp.addTitle')}</DialogTitle>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">{t('mcp.addTitle')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('mcp.addDescription')}</p>
            </div>
            <button type="button" className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              aria-label={t('mcp.cancel')} onClick={() => { setManualOpen(false); setManualError(''); }}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {manualError && (
              <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {manualError}
              </p>
            )}
            {!projectReady && <p className="text-xs text-muted-foreground">{t('mcp.projectRequired')}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.name')}
                <input className={`mt-1 ${inputClass}`} value={manual.name} placeholder="home-assistant"
                  autoFocus
                  onChange={(event) => setManual((current) => ({ ...current, name: event.target.value }))} />
                <span className="mt-1 block font-normal">{t('mcp.nameHint')}</span>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.transport')}
                <select aria-label={t('mcp.transport')} className={`mt-1 ${inputClass}`} value={manual.transport}
                  onChange={(event) => setManual((current) => ({ ...current, transport: event.target.value as McpTransport }))}>
                  <option value="stdio">{t('mcp.transportStdio')}</option>
                  <option value="http">{t('mcp.transportHttp')}</option>
                  <option value="sse">{t('mcp.transportSse')}</option>
                </select>
              </label>
              {manual.transport === 'stdio' ? (
                <>
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('mcp.command')}
                    <input className={`mt-1 ${inputClass}`} value={manual.command} placeholder="npx"
                      onChange={(event) => setManual((current) => ({ ...current, command: event.target.value }))} />
                  </label>
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('mcp.args')}
                    <textarea className={`mt-1 ${inputClass}`} rows={3} value={manual.args}
                      placeholder={'-y\nsome-mcp-server'}
                      onChange={(event) => setManual((current) => ({ ...current, args: event.target.value }))} />
                    <span className="mt-1 block font-normal">{t('mcp.argsHint')}</span>
                  </label>
                </>
              ) : (
                <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
                  {t('mcp.url')}
                  <input className={`mt-1 ${inputClass}`} value={manual.url} placeholder="https://home-assistant.local/mcp"
                    onChange={(event) => setManual((current) => ({ ...current, url: event.target.value }))} />
                </label>
              )}
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.env')}
                <textarea className={`mt-1 ${inputClass}`} rows={2} value={manual.env} placeholder="TOKEN=…"
                  onChange={(event) => setManual((current) => ({ ...current, env: event.target.value }))} />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.headers')}
                <textarea className={`mt-1 ${inputClass}`} rows={2} value={manual.headers} placeholder="Authorization: Bearer …"
                  onChange={(event) => setManual((current) => ({ ...current, headers: event.target.value }))} />
              </label>
            </div>
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
            <button type="button" className={buttonClass} onClick={() => { setManualOpen(false); setManualError(''); }}>
              {t('mcp.cancel')}
            </button>
            <button type="button" className={primaryButtonClass} disabled={!manualValid || busy === 'manual'}
              onClick={() => void addManual()}>
              {busy === 'manual' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {busy === 'manual' ? t('mcp.adding') : t('mcp.add')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
