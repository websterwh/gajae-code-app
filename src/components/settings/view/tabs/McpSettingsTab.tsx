import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, Loader2, Pencil, Pin, Plus, RefreshCw, Search, Server, Trash2, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

import { formatMcpBlock, parseMcpBlock } from './mcpBlock';

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
  /** Resolved from the registry when this app never installed the package. */
  availableVersion?: string | null;
};

type CatalogEnv = { name: string; required?: boolean; secret?: boolean; description?: string };
/** What a catalog entry says a server needs, used to prefill its configure form. */
type CatalogDefaults = { env: CatalogEnv[]; command?: string; args?: string[]; url?: string };
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
// w-28 rather than w-full: the version chip and the input that replaces it have
// to occupy the same space, or the row's action bar jumps when the chip is clicked.
const versionInputClass = 'w-28 touch-manipulation rounded-lg border border-input bg-card px-2 py-1 font-mono text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
// Controls whose label swaps (Verify/Verifying, Pin/Unpin) hold their width so
// the rest of the bar does not shift while a request runs.
const verifyButtonClass = `${buttonClass} min-w-28 justify-center whitespace-nowrap`;
const pinnedButtonClass = `${buttonClass} min-w-20 justify-center whitespace-nowrap`;
const versionChipClass = `${buttonClass} w-28 justify-center font-mono`;

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
  const [catalogDefaults, setCatalogDefaults] = useState<Record<string, CatalogDefaults>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<McpScope>('global');
  const [projectPath, setProjectPath] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  // Relevance is the default because it is the only order that means something
  // for a query: curated and well-known servers lead, instead of whatever
  // vendor namespace happens to start with the letter a.
  const [sort, setSort] = useState<CatalogSort>('relevance');
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
  const [editingVersion, setEditingVersion] = useState<string | null>(null);
  const [versionDraft, setVersionDraft] = useState('');
  // Blur also fires on Escape; this keeps that path from writing a pin.
  const skipPinCommit = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ block: '' });
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

  const rememberCatalog = useCallback((entries: CatalogEntry[]) => {
    setCatalogDefaults((current) => {
      const next = { ...current };
      for (const entry of entries) {
        const defaults: CatalogDefaults = {
          env: entry.env ?? [],
          ...(entry.command ? { command: entry.command } : {}),
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.url ? { url: entry.url } : {}),
        };
        next[entry.name] = defaults;
        if (entry.package?.name) next[`pkg:${entry.package.name}`] = defaults;
      }
      return next;
    });
  }, []);

  // A server installed from the catalog is looked up by name first, then by the
  // package it runs, so renamed entries still bring their fields along.
  const catalogFor = useCallback((server: McpServer): CatalogDefaults | undefined => (
    catalogDefaults[server.name] ?? (server.packageName ? catalogDefaults[`pkg:${server.packageName}`] : undefined)
  ), [catalogDefaults]);

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

  // Boot provisioning runs in another process, so a snapshot that said
  // "running" when the page loaded has to be asked about again.
  useEffect(() => {
    if (!status?.inFlight) return;
    const timer = window.setInterval(() => {
      void request<StatusData>(statusPath).then((next) => setStatus(next)).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [status?.inFlight, statusPath]);

  // The highlight and the New badge mark the moment of an install, not a
  // permanent property of the row.
  useEffect(() => {
    if (!recentlyAdded) return;
    const timer = window.setTimeout(() => setRecentlyAdded(null), 12000);
    return () => window.clearTimeout(timer);
  }, [recentlyAdded]);

  useEffect(() => {
    if (!copyNote) return;
    const timer = window.setTimeout(() => setCopyNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [copyNote]);

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
      .then((result) => rememberCatalog(result.entries))
      .catch(() => undefined);
  }, [rememberCatalog]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (source) params.set('source', source);
      // The sort stays in force while a query narrows the list.
      params.set('sort', sort);
      void request<{ entries: CatalogEntry[]; warning?: string; registryError?: string; counts: CatalogCounts }>(`/api/mcp/catalog?${params.toString()}`)
        .then((result) => {
          setCatalog(result.entries);
          setCatalogWarning(result.warning ?? null);
          setRegistryError(result.registryError ?? null);
          if (result.counts) setCatalogCounts(result.counts);
          rememberCatalog(result.entries);
        })
        .catch((catalogError) => setError(messageOf(catalogError)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [rememberCatalog, search, sort, source]);

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

  const setPin = async (server: McpServer, version: string | null) => {
    setBusy(`pin:${server.name}`);
    setError('');
    try {
      await request(serverPath(server, '/pin'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      await reload();
    } catch (pinError) {
      setError(messageOf(pinError));
    } finally {
      setBusy(null);
    }
  };

  const pinVersion = (server: McpServer) => {
    void setPin(server, server.pin ? null : (server.install?.version ?? server.availableVersion ?? null));
  };

  const beginVersionEdit = (server: McpServer) => {
    skipPinCommit.current = false;
    setVersionDraft(server.pin ?? server.install?.version ?? '');
    setEditingVersion(server.name);
  };

  // Confirming an edited version pins the server to it, so the version itself is
  // the pin control instead of a standing input in every row.
  const commitVersionEdit = (server: McpServer) => {
    if (skipPinCommit.current) {
      skipPinCommit.current = false;
      return;
    }
    const next = versionDraft.trim();
    setEditingVersion(null);
    if (next === (server.pin ?? '')) return;
    void setPin(server, next || null);
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

  // Open on what the server already runs, falling back to the catalog entry so
  // the form starts filled instead of asking for the same values again.
  const beginEdit = (server: McpServer) => {
    const known = catalogFor(server);
    setEditing(server.name);
    // The form renders in the installed list, which may be off screen when the
    // action came from a catalog card further down the page.
    window.setTimeout(() => {
      document.getElementById(`mcp-edit-${server.name}`)?.scrollIntoView?.({ block: 'center' });
    }, 0);
    // The form is the block mcp.json gets, filled from what the server already
    // runs and topped up with the catalog entry when the row is empty.
    const command = server.command ?? known?.command;
    const args = server.args ?? known?.args;
    const url = server.url ?? known?.url;
    setEditDraft({
      block: formatMcpBlock(
        {
          ...server,
          ...(command ? { command } : {}),
          ...(args ? { args } : {}),
          ...(url ? { url } : {}),
        },
        (known?.env ?? []).map((variable) => variable.name),
      ),
    });
  };

  // What parses out of the block is exactly what gets written, so a stdio
  // entry without a command or a remote one without a URL is the only thing
  // that can leave Save unavailable.
  const editBlock = parseMcpBlock(editDraft.block);
  const editReady = (server: McpServer): boolean => (
    editBlock.ok && (server.transport === 'stdio' ? Boolean(editBlock.value.command) : Boolean(editBlock.value.url))
  );

  const saveEdit = async (server: McpServer) => {
    if (!editBlock.ok) return;
    setBusy(`edit:${server.name}`);
    setError('');
    try {
      const patch: Record<string, unknown> = {};
      if (server.transport === 'stdio') {
        patch.command = editBlock.value.command ?? '';
        patch.args = editBlock.value.args ?? [];
      } else {
        patch.url = editBlock.value.url ?? '';
      }
      if (editBlock.value.env) patch.env = editBlock.value.env;
      if (editBlock.value.headers) patch.headers = editBlock.value.headers;
      await request(serverPath(server), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      // The handshake result belonged to the config that was just replaced.
      setVerifyResults((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
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
      rememberCatalog([entry]);
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
  // The catalog is for finding something new; a server already in the config
  // is configured from the list above, so it is left out here.
  const uninstalled = catalog.filter((entry) => !servers.some((server) => server.name === entry.name));

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
          <div className="flex flex-wrap items-start gap-3 p-4">
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
              </label>
            )}
            <button type="button" className={`${buttonClass} h-9`} onClick={() => setManualOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{t('mcp.manuallyAdd')}
            </button>
          </div>
          {/* The path sits under the row, not inside the label: a longer line
              inside the second box pushed its select out of line with the
              scope select beside it. */}
          {scope === 'project' && (selectedProject || (!projectsLoading && projects.length === 0)) && (
            <p className="truncate px-4 pb-3 font-mono text-[11px] text-muted-foreground">
              {selectedProject ? selectedProject.path : `${t('mcp.noProjects')} ${t('mcp.noProjectsHint')}`}
            </p>
          )}
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
            const version = server.pin ?? install?.version ?? server.availableVersion ?? null;
            const removeKey = `row:${server.scope}:${server.name}`;
            const knownVars = catalogFor(server)?.env ?? [];
            const missingRequired = knownVars.filter((variable) => variable.required && !server.envIsSet[variable.name]);
            return (
              <div key={`${server.scope}:${server.name}`} className={`p-4 ${recentlyAdded === server.name ? 'bg-primary/5' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* The switch opens the row on every server. Trailing the
                      buttons put it wherever that row's controls ended, so a
                      row with pin controls showed it further left than one
                      without, and the toggles never lined up. */}
                  <SettingsToggle
                    checked={server.enabled}
                    onChange={() => void toggle(server)}
                    ariaLabel={`${server.enabled ? t('mcp.enabled') : t('mcp.disabled')}: ${server.name}`}
                  />
                  <div className="min-w-0 flex-1">
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
                    {/* A pinnable row carries its version on the control, the
                        same as the packages tab. A remote server has no
                        package version to report, so it gets no line at all. */}
                    {server.pinnable && install?.status === 'failed' && (
                      <p className="mt-1 text-xs text-muted-foreground">{t('mcp.failed')}</p>
                    )}
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2">
                    {/* The label stays put while the handshake runs: swapping it
                        for the longer text made the whole bar jump. */}
                    <button type="button" className={verifyButtonClass} aria-busy={verifying === server.name}
                      disabled={verifying === server.name} onClick={() => void verify(server)}
                      title={verifying === server.name ? t('mcp.verifying') : t('mcp.verify')}>
                      {verifying === server.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                      {t('mcp.verify')}
                    </button>
                    <button type="button" className={buttonClass} onClick={() => beginEdit(server)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />{t('mcp.configure')}
                    </button>
                    {/* A remote server has no package version, so the control is
                        absent rather than disabled with nothing to lock. */}
                    {server.pinnable && (
                      <div className="flex items-center gap-1">
                        {editingVersion === server.name ? (
                          <input
                            autoFocus
                            value={versionDraft}
                            onChange={(event) => setVersionDraft(event.target.value)}
                            onBlur={() => commitVersionEdit(server)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                event.currentTarget.blur();
                              } else if (event.key === 'Escape') {
                                skipPinCommit.current = true;
                                setEditingVersion(null);
                              }
                            }}
                            placeholder={t('mcp.pinPlaceholder')}
                            aria-label={`${t('mcp.version')} ${server.name}`}
                            className={versionInputClass}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginVersionEdit(server)}
                            title={t('mcp.versionHint')}
                            aria-label={`${t('mcp.version')} ${server.name}: ${version ?? t('mcp.noVersion')}`}
                            className={versionChipClass}
                          >
                            <Pencil className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                            <span className="min-w-0 truncate">{version ?? t('mcp.noVersion')}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy === `pin:${server.name}` || (!server.pin && !install?.version)}
                          onClick={() => pinVersion(server)}
                          aria-label={`${server.pin ? t('mcp.unpin') : t('mcp.pin')} ${server.name}`}
                          title={server.pin ? t('mcp.unpin') : t('mcp.pin')}
                          className={pinnedButtonClass}
                        >
                          {busy === `pin:${server.name}`
                            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                            : <Pin className={`h-3 w-3 ${server.pin ? 'fill-current' : ''}`} aria-hidden />}
                          {server.pin ? t('mcp.unpin') : t('mcp.pin')}
                        </button>
                      </div>
                    )}
                    {confirmRemove === removeKey ? (
                      <button type="button" className={`${buttonClass} border-destructive text-destructive`}
                        disabled={busy === `remove:${server.name}`} onClick={() => void remove(server)}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('mcp.confirmRemove')}
                      </button>
                    ) : (
                      <button type="button" className={buttonClass} onClick={() => setConfirmRemove(removeKey)}>
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
                {editing === server.name && (
                  <div id={`mcp-edit-${server.name}`} className="mt-3 grid gap-2 rounded-lg border border-border p-3">
                    <label className="text-xs text-muted-foreground">
                      {t('mcp.configBlock')}
                      <textarea
                        className={`mt-1 ${inputClass} font-mono leading-relaxed`}
                        rows={10}
                        spellCheck={false}
                        autoFocus
                        value={editDraft.block}
                        aria-label={`${t('mcp.configBlock')} ${server.name}`}
                        onChange={(event) => setEditDraft({ block: event.target.value })}
                      />
                      <span className="mt-1 block font-normal">{t('mcp.configBlockHint')}</span>
                      <span className="mt-1 block font-normal">{t('mcp.envKeep')}</span>
                    </label>
                    {!editBlock.ok && (
                      <p role="alert" className="text-xs text-destructive">{t('mcp.blockInvalid')}</p>
                    )}
                    {editBlock.ok && !editReady(server) && (
                      <p className="text-xs text-destructive">{t('mcp.blockNeedsCommand')}</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button type="button" className={buttonClass} onClick={() => setEditing(null)}>{t('mcp.cancel')}</button>
                      <button type="button" className={primaryButtonClass} disabled={busy === `edit:${server.name}` || !editReady(server)}
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
          <div className="grid gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
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
                <option value="registry">{t('mcp.sourceRegistry')} ({catalogCounts.registry})</option>
              </select>
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              {t('mcp.sort')}
              <select aria-label={t('mcp.sort')} className={`mt-1 ${inputClass}`} value={sort}
                onChange={(event) => setSort(event.target.value as CatalogSort)}>
                <option value="name">{t('mcp.sortName')}</option>
                <option value="relevance">{t('mcp.sortRelevance')}</option>
                <option value="popularity">{t('mcp.sortPopularity')}</option>
              </select>
            </label>
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
          {catalog.length > 0 && uninstalled.length === 0 && (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{t('mcp.allInstalled')}</p>
          )}
          {uninstalled.map((entry) => {
            const isBusy = busy === `install:${entry.name}`;
            return (
              <div key={`${entry.source}:${entry.name}`}
                className={`border-t border-border p-4 ${recentlyAdded === entry.name ? 'bg-primary/5' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
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
                  <div className="flex w-full flex-wrap items-center gap-2">
                    <button type="button" className={primaryButtonClass} disabled={isBusy || !projectReady}
                      onClick={() => void installEntry(entry)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                      {isBusy ? t('mcp.installing') : t('mcp.install')}
                    </button>
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
              {/* Headers only apply to remote transports, the same as Configure. */}
              {manual.transport !== 'stdio' && (
                <label className="text-xs font-medium text-muted-foreground">
                  {t('mcp.headers')}
                  <textarea className={`mt-1 ${inputClass}`} rows={2} value={manual.headers} placeholder="Authorization: Bearer …"
                    onChange={(event) => setManual((current) => ({ ...current, headers: event.target.value }))} />
                </label>
              )}
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
