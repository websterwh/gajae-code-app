import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, Package as PackageIcon, Pencil, Pin, RefreshCw, Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

type Manager = 'uv' | 'pip' | 'npm' | 'aqua' | 'apt';
/** `auto` searches every source and installs through whichever one matched. */
type ManagerChoice = Manager | 'auto';
type PackageSuggestion = {
  manager: Manager;
  name: string;
  spec: string;
  description: string;
};
type PackageRow = {
  manager: Manager;
  name: string;
  spec: string;
  pin: string | null;
  source: 'env' | 'ui' | 'installed';
  desired: boolean;
  status: 'installed' | 'failed' | 'missing';
  version: string | null;
  error?: string;
  updatedAt?: string;
};

type ApiEnvelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

const MANAGERS: ManagerChoice[] = ['auto', 'uv', 'pip', 'npm', 'aqua', 'apt'];

const inputClass = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';
const chipClass = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground';
const destructiveButtonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50';
// w-28 rather than w-full: the version chip and the input that replaces it have
// to occupy the same space, or the row's action bar jumps when the chip is clicked.
const versionInputClass = 'w-28 touch-manipulation rounded-lg border border-input bg-card px-2 py-1 font-mono text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
// Controls whose label swaps (Pin/Unpin) hold their width so the bar stays put.
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Request failed.');

const packagePath = (row: { manager: Manager; name: string }): string => (
  `/api/packages/${row.manager}/${encodeURIComponent(row.name)}`
);

export default function PackagesSettingsTab() {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<PackageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ manager: ManagerChoice; spec: string; pin: string }>({ manager: 'auto', spec: '', pin: '' });
  const [suggestions, setSuggestions] = useState<PackageSuggestion[]>([]);
  const [editingVersion, setEditingVersion] = useState<string | null>(null);
  const [versionDraft, setVersionDraft] = useState('');
  const [confirming, setConfirming] = useState<PackageRow | null>(null);
  const skipPinCommit = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await request<PackageRow[]>('/api/packages');
      setRows(next);
      setError('');
    } catch (loadError) {
      setError(`${t('packages.loadFailed')} ${messageOf(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Suggestions come from the same sources an install would use: apt's local
  // index, the npm registry, PyPI and GitHub. The selected manager narrows the
  // sources, so "aqua" cannot answer with npm packages. Typing is debounced so
  // a name does not become a request per keystroke.
  useEffect(() => {
    const query = form.spec.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    const scope = form.manager === 'auto' ? '' : `&manager=${form.manager}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void authenticatedFetch(`/api/packages/suggest?q=${encodeURIComponent(query)}${scope}`, { signal: controller.signal })
        .then(async (response) => (await response.json() as ApiEnvelope<PackageSuggestion[]>).data ?? [])
        .then((next) => { if (!controller.signal.aborted) setSuggestions(next); })
        .catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [form.spec, form.manager]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(`${t('packages.actionFailed')} ${messageOf(actionError)}`);
    } finally {
      setBusy(null);
    }
  };

  /** The manager `auto` means for a hand-typed spec that was never clicked. */
  const resolveManager = (spec: string): Manager => {
    if (form.manager !== 'auto') return form.manager;
    const needle = spec.toLowerCase();
    const exact = suggestions.find((suggestion) => (
      suggestion.name.toLowerCase() === needle || suggestion.spec.toLowerCase() === needle
    ));
    if (exact) return exact.manager;
    // `github` is not a package name anywhere, but exactly one source knows
    // what it means: follow that source instead of guessing uv.
    if (suggestions.length === 1) return suggestions[0].manager;
    // A bare owner/repo has no PyPI or npm package to be confused with.
    if (/^[^/@\s]+\/[^/@\s]+$/u.test(spec)) return 'aqua';
    return 'uv';
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const spec = form.spec.trim();
    if (!spec) return;
    const manager = resolveManager(spec);
    void run('add', async () => {
      await request('/api/packages', {
        method: 'POST',
        body: JSON.stringify({ manager, spec, pin: form.pin.trim() || null }),
      });
      setForm({ ...form, spec: '', pin: '' });
    });
  };

  // Clicking a suggestion is the install: the manager that recognised the
  // name is the one that runs, so the user does not have to know which it was.
  const installSuggestion = (suggestion: PackageSuggestion) => {
    setForm({ ...form, manager: suggestion.manager, spec: suggestion.spec, pin: '' });
    setSuggestions([]);
    void run(`add:${suggestion.manager}:${suggestion.name}`, () => request('/api/packages', {
      method: 'POST',
      body: JSON.stringify({ manager: suggestion.manager, spec: suggestion.spec, pin: null }),
    }));
  };

  const retry = (row: PackageRow) => void run(`retry:${row.manager}:${row.name}`, () => request('/api/packages', {
    method: 'POST',
    body: JSON.stringify({ manager: row.manager, spec: row.spec, pin: row.pin }),
  }));

  const pinVersion = (row: PackageRow, pin: string | null) => {
    const key = `${row.manager}:${row.name}`;
    void run(`pin:${key}`, () => request(packagePath(row), { method: 'PATCH', body: JSON.stringify({ pin }) }));
  };

  const beginVersionEdit = (row: PackageRow) => {
    skipPinCommit.current = false;
    setVersionDraft(row.pin ?? row.version ?? '');
    setEditingVersion(`${row.manager}:${row.name}`);
  };

  // Confirming an edited version pins the package to it, so the version chip is
  // the pin control instead of a standing input in every row.
  const commitVersionEdit = (row: PackageRow) => {
    if (skipPinCommit.current) {
      skipPinCommit.current = false;
      return;
    }
    const next = versionDraft.trim();
    setEditingVersion(null);
    if (next === (row.pin ?? '')) return;
    pinVersion(row, next || null);
  };

  const remove = (row: PackageRow) => setConfirming(row);

  const confirmRemove = () => {
    const row = confirming;
    if (!row) return;
    setConfirming(null);
    void run(`remove:${row.manager}:${row.name}`, () => requestVoid(packagePath(row), { method: 'DELETE' }));
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t('packages.title')} description={t('packages.description')}>
        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-words">{error}</span>
          </p>
        ) : null}
        <SettingsCard divided>
          <form onSubmit={add} className="grid gap-2 p-4 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,8rem)_auto]">
            <select
              value={form.manager}
              onChange={(event) => setForm({ ...form, manager: event.target.value as ManagerChoice })}
              aria-label={t('packages.manager')}
              className={`${inputClass} py-2`}
            >
              {MANAGERS.map((manager) => (
                <option key={manager} value={manager}>
                  {manager === 'auto' ? t('packages.managerAuto') : manager}
                </option>
              ))}
            </select>
            <input
              value={form.spec}
              onChange={(event) => setForm({ ...form, spec: event.target.value })}
              placeholder={t('packages.specPlaceholder')}
              aria-label={t('packages.spec')}
              className={inputClass}
            />
            <input
              value={form.pin}
              onChange={(event) => setForm({ ...form, pin: event.target.value })}
              placeholder={t('packages.pinPlaceholder')}
              aria-label={t('packages.pin')}
              className={inputClass}
            />
            <button type="submit" disabled={busy !== null || !form.spec.trim()} className={primaryButtonClass}>
              {busy === 'add' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <PackageIcon className="h-3 w-3" aria-hidden />}
              {busy === 'add' ? t('packages.adding') : t('packages.add')}
            </button>
          </form>

          {suggestions.length > 0 ? (
            <div className="border-t border-border px-4 py-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {t('packages.suggestions', { defaultValue: 'Matching packages — click one to install it, or keep typing and press Add' })}
              </p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={`${suggestion.manager}:${suggestion.name}`}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => installSuggestion(suggestion)}
                    title={suggestion.description || suggestion.spec}
                    className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="truncate font-medium">{suggestion.name}</span>
                    <span className="text-muted-foreground">{suggestion.manager}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {loading ? (
            <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t('packages.loading')}
            </p>
          ) : null}
          {!loading && rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('packages.empty')}</p> : null}

          {rows.map((row) => {
            const key = `${row.manager}:${row.name}`;
            const statusLabel = row.status === 'installed' ? t('packages.statusInstalled')
              : row.status === 'failed' ? t('packages.statusFailed')
                : t('packages.statusMissing');
            // Rows that can be pinned carry the version on the control itself;
            // the rest keep it in the status line.
            const versionControl = row.desired;
            const version = row.pin ?? row.version;
            return (
              <div key={key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
                    <span className={chipClass}>{row.manager}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {row.status === 'installed'
                        ? <CheckCircle2 className="h-3 w-3" aria-hidden />
                        : <AlertTriangle className="h-3 w-3" aria-hidden />}
                      {statusLabel}
                      {row.version && !versionControl ? ` · ${row.version}` : ''}
                    </span>
                    {row.updatedAt ? <span>{new Date(row.updatedAt).toLocaleDateString()}</span> : null}
                  </div>
                  {row.error ? <p className="mt-1 text-xs break-words text-destructive">{row.error}</p> : null}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {row.desired && row.status !== 'installed' ? (
                    <button type="button" disabled={busy !== null} onClick={() => retry(row)} className={buttonClass}>
                      {busy === `retry:${key}` ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
                      {t('packages.retry')}
                    </button>
                  ) : null}
                  {versionControl ? (
                    <div className="flex items-center gap-1">
                      {editingVersion === key ? (
                        <input
                          autoFocus
                          value={versionDraft}
                          onChange={(event) => setVersionDraft(event.target.value)}
                          onBlur={() => commitVersionEdit(row)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                              skipPinCommit.current = true;
                              setEditingVersion(null);
                            }
                          }}
                          placeholder={t('packages.pinPlaceholder')}
                          aria-label={`${t('packages.version')} ${row.name}`}
                          className={versionInputClass}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => beginVersionEdit(row)}
                          title={t('packages.versionHint')}
                          aria-label={`${t('packages.version')} ${row.name}: ${version ?? t('packages.noVersion')}`}
                          className={versionChipClass}
                        >
                          <Pencil className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                          <span className="min-w-0 truncate">{version ?? t('packages.noVersion')}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy !== null || (!row.pin && !row.version)}
                        onClick={() => pinVersion(row, row.pin ? null : row.version)}
                        aria-label={`${row.pin ? t('packages.unpin') : t('packages.pinAction')} ${row.name}`}
                        title={row.pin ? t('packages.unpin') : t('packages.pinAction')}
                        className={pinnedButtonClass}
                      >
                        {busy === `pin:${key}` ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Pin className={`h-3 w-3 ${row.pin ? 'fill-current' : ''}`} aria-hidden />}
                        {row.pin ? t('packages.unpin') : t('packages.pinAction')}
                      </button>
                    </div>
                  ) : null}
                  {row.source === 'ui' ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => remove(row)}
                      aria-label={`${t('packages.remove')} ${row.name}`}
                      className={buttonClass}
                    >
                      {busy === `remove:${key}` ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Trash2 className="h-3 w-3" aria-hidden />}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </SettingsCard>
        <p className="text-xs text-muted-foreground">{t('packages.pinnedNote')}</p>
      </SettingsSection>

      {/* The removal is destructive, so it asks first - and asks in the app,
          not in a browser confirm that ignores the theme. */}
      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <DialogContent
          aria-labelledby="packages-remove-title"
          className="w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-2xl border-border/80 bg-popover p-0 shadow-2xl"
        >
          <DialogTitle id="packages-remove-title">
            {confirming ? t('packages.confirmRemove', { name: confirming.name }) : ''}
          </DialogTitle>
          <div className="flex items-start gap-3 px-4 pt-4 pb-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {confirming ? t('packages.confirmRemove', { name: confirming.name }) : ''}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {confirming ? t('packages.confirmRemoveBody', { name: confirming.name, manager: confirming.manager }) : ''}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
            <button type="button" className={buttonClass} onClick={() => setConfirming(null)}>
              {t('packages.cancel')}
            </button>
            <button type="button" className={destructiveButtonClass} onClick={confirmRemove} disabled={confirming === null}>
              <Trash2 className="h-3 w-3" aria-hidden />
              {t('packages.uninstall')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
