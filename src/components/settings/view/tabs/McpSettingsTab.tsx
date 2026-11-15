import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Loader2, Pencil, Pin, Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
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
  source: 'bundled' | 'overlay' | 'registry';
};

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

export default function McpSettingsTab() {
  const { t } = useTranslation('settings');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<McpScope>('global');
  const [projectPath, setProjectPath] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
  const [pinDrafts, setPinDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ command: '', args: '', url: '', env: '', headers: '' });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [catalogInputs, setCatalogInputs] = useState<Record<string, string>>({});
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [manual, setManual] = useState({
    name: '', transport: 'stdio' as McpTransport, command: '', args: '', url: '', env: '', headers: '',
  });

  const projectQuery = scope === 'project' && projectPath ? `&projectPath=${encodeURIComponent(projectPath)}` : '';
  const listPath = `/api/mcp/servers?scope=${scope === 'project' ? 'all' : 'global'}${projectQuery}`;
  const statusPath = `/api/mcp/status${projectQuery ? `?${projectQuery.slice(1)}` : ''}`;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextServers, nextStatus] = await Promise.all([
        request<McpServer[]>(listPath),
        request<StatusData>(statusPath),
      ]);
      setServers(nextServers);
      setStatus(nextStatus);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [listPath, statusPath]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (source) params.set('source', source);
      void request<{ entries: CatalogEntry[]; warning?: string }>(`/api/mcp/catalog?${params.toString()}`)
        .then((result) => { setCatalog(result.entries); setCatalogWarning(result.warning ?? null); })
        .catch((catalogError) => setError(messageOf(catalogError)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, source]);

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
      const env = parsePairs(editDraft.env, '=');
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
    const env: Record<string, string> = {};
    for (const variable of entry.env ?? []) {
      const value = catalogInputs[`${entry.name}:${variable.name}`] ?? '';
      if (variable.required && !value) {
        setError(t('mcp.requiresSecret', { name: variable.name }));
        return;
      }
      if (value) env[variable.name] = value;
    }
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
          ...(Object.keys(env).length ? { env } : {}),
          scope,
          ...(scope === 'project' ? { projectPath } : {}),
        }),
      });
      await reload();
    } catch (installError) {
      setError(`${t('mcp.installFailed')} ${messageOf(installError)}`);
    } finally {
      setBusy(null);
    }
  };

  const addManual = async () => {
    setBusy('manual');
    setError('');
    try {
      const env = parsePairs(manual.env, '=');
      const headers = parsePairs(manual.headers, ':');
      await request('/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: manual.name.trim(),
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
      await reload();
    } catch (addError) {
      setError(`${t('mcp.installFailed')} ${messageOf(addError)}`);
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

  return (
    <div className="space-y-6">
      <SettingsSection title={t('mcp.title')} description={t('mcp.description')}>
        <SettingsCard>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.scope')}
              <select
                aria-label={t('mcp.scope')}
                value={scope}
                onChange={(event) => setScope(event.target.value === 'project' ? 'project' : 'global')}
                className={`mt-1 ${inputClass}`}
              >
                <option value="global">{t('mcp.scopeGlobal')}</option>
                <option value="project">{t('mcp.scopeProject')}</option>
              </select>
            </label>
            {scope === 'project' && (
              <label className="text-xs font-medium text-muted-foreground">
                {t('mcp.projectPath')}
                <input
                  className={`mt-1 ${inputClass}`}
                  value={projectPath}
                  placeholder="/workspace/project"
                  onChange={(event) => setProjectPath(event.target.value)}
                />
                <span className="mt-1 block font-normal">{t('mcp.projectPathHint')}</span>
              </label>
            )}
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
            return (
              <div key={`${server.scope}:${server.name}`} className="p-4">
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
                      <Pencil className="h-3.5 w-3.5" aria-hidden />{t('mcp.edit')}
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
                      <button type="button" className={buttonClass} disabled={busy === `edit:${server.name}`}
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
          <div className="grid gap-2 p-4 sm:grid-cols-2">
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
                <option value="">{t('mcp.sourceAll')}</option>
                <option value="bundled">{t('mcp.sourceBundled')}</option>
                <option value="overlay">{t('mcp.sourceOverlay')}</option>
                <option value="registry">{t('mcp.sourceRegistry')}</option>
              </select>
            </label>
          </div>
          {catalogWarning && (
            <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{catalogWarning}</p>
          )}
          {catalog.length === 0 && (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{t('mcp.noResults')}</p>
          )}
          {catalog.map((entry) => {
            const required = (entry.env ?? []).filter((variable) => variable.required);
            const missing = required.some((variable) => !(catalogInputs[`${entry.name}:${variable.name}`] ?? ''));
            return (
              <div key={`${entry.source}:${entry.name}`} className="border-t border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{entry.title ?? entry.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                    <p className="mt-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                      {entry.transport} · {entry.source}
                    </p>
                  </div>
                  <button type="button" className={buttonClass} disabled={busy === `install:${entry.name}` || missing}
                    aria-disabled={missing} onClick={() => void installEntry(entry)}>
                    {busy === `install:${entry.name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                    {busy === `install:${entry.name}` ? t('mcp.installing') : t('mcp.install')}
                  </button>
                </div>
                {(entry.env ?? []).length > 0 && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(entry.env ?? []).map((variable) => (
                      <label key={variable.name} className="text-xs text-muted-foreground">
                        {variable.name}{variable.required ? ' *' : ''}
                        <input
                          className={`mt-1 ${inputClass}`}
                          type={variable.secret ? 'password' : 'text'}
                          autoComplete="off"
                          value={catalogInputs[`${entry.name}:${variable.name}`] ?? ''}
                          onChange={(event) => setCatalogInputs((current) => ({ ...current, [`${entry.name}:${variable.name}`]: event.target.value }))}
                        />
                        {variable.description && <span className="mt-1 block font-normal">{variable.description}</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mcp.addTitle')} description={t('mcp.addDescription')}>
        <SettingsCard>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.name')}
              <input className={`mt-1 ${inputClass}`} value={manual.name} placeholder="home-assistant"
                onChange={(event) => setManual((current) => ({ ...current, name: event.target.value }))} />
              <span className="mt-1 block font-normal">{t('mcp.nameHint')}</span>
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.scope')}
              <select aria-label={t('mcp.scope')} className={`mt-1 ${inputClass}`} value={manual.transport}
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
          <div className="flex justify-end border-t border-border px-4 py-3">
            <button type="button" className={buttonClass} disabled={busy === 'manual' || !manual.name.trim()}
              onClick={() => void addManual()}>
              {busy === 'manual' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
              {busy === 'manual' ? t('mcp.adding') : t('mcp.add')}
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mcp.statusTitle')} description={t('mcp.statusDescription')}>
        <SettingsCard divided>
          <p role="status" className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            {status?.inFlight ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
            {status?.inFlight ? t('mcp.inFlight') : t('mcp.idle')}
            {status?.provisioning?.current ? ` · ${status.provisioning.current.manager}: ${status.provisioning.current.package}` : ''}
          </p>
          <div className="border-t border-border p-4">
            <h4 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="h-4 w-4" aria-hidden />{t('mcp.failedInstalls')}
            </h4>
            {(status?.failed ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('mcp.noFailedInstalls')}</p>
            ) : (status?.failed ?? []).map((failure) => (
              <p key={`${failure.manager}:${failure.name}`} className="mt-1 text-xs text-destructive">
                {failure.manager} · {failure.name}: {failure.entry.error ?? ''}
              </p>
            ))}
          </div>
          <div className="border-t border-border p-4">
            <h4 className="text-sm font-medium text-foreground">{t('mcp.missingMounts')}</h4>
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
          <div className="border-t border-border p-4">
            <h4 className="text-sm font-medium text-foreground">{t('mcp.ledger')}</h4>
            {ledgerRows.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('mcp.noLedger')}</p>
            ) : ledgerRows.map((row) => (
              <p key={`${row.manager}:${row.name}`} className="mt-1 text-xs text-muted-foreground">
                {row.manager} · {row.name} · {row.entry.version ?? '—'} · {row.entry.status}
                {row.entry.pin ? ` · ${t('mcp.pinnedTo', { version: row.entry.pin })}` : ''}
              </p>
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
