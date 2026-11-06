import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAppShellStore } from '../../../../stores/useAppShellStore';
import { builtinBrowserFailure, builtinBrowserOwnerId, hasBuiltinBrowserBridge, openBuiltinBrowser } from '../../../../utils/builtinBrowser';
import { BROWSER_BACKENDS, isBrowserBackend, type BrowserBackend } from '../../browserBackends';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type Status = {
  supported: boolean;
  platform: string;
  architecture: string;
  capabilities?: { browser: boolean; computer: boolean };
  browser: { error?: string };
  cua: { installed: boolean; version?: string; daemon: string; accessibility?: boolean; screenRecording?: boolean; error?: string };
};

type EgoReadiness = {
  ready: boolean;
  status: 'ready' | 'not_ready' | 'unknown';
  issues?: Array<{ code: string; state: string }>;
  warnings?: string[];
  versions?: { cli: string; app: string; skill: string };
};

type EgoConnection = {
  ok: boolean;
  status: 'connected' | 'not_connected' | 'failed';
  cliVersion?: string;
  message?: string;
};

type Grants = {
  always: { origins: string[]; applications: string[] };
};

type RemoteDevice = {
  id: string;
  name: string;
  os: string;
  enabled: boolean;
  revoked: boolean;
  lastSeenAt?: number;
  readiness?: {
    driverVersion?: string;
    schemaSupported: boolean;
    daemon: 'running' | 'stopped' | 'unknown';
    accessibility?: boolean;
    screenRecording?: boolean;
  };
};

const selectClass = 'touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
function companionPlatform(): string {
  const platform = navigator.userAgent.includes('Windows') ? 'windows-x64.exe'
    : navigator.userAgent.includes('Mac') ? 'macos-universal.dmg' : 'linux-x64';
  return platform;
}

// The macOS .app bundle has no pairing/settings UI yet; it only wraps the
// same CLI binary below, so offer the raw binary explicitly for terminal use
// until a real GUI ships.
function companionMacCliPlatform(): string {
  return navigator.userAgent.includes('Mac') && navigator.userAgent.includes('ARM') ? 'darwin-arm64' : 'darwin-x64';
}

export default function AutomationSettingsTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<Status | null>(null);
  const [grants, setGrants] = useState<Grants | null>(null);
  const [loading, setLoading] = useState(true);
  const [browserBackend, setBrowserBackend] = useState<BrowserBackend | null>(null);
  const [availableBackends, setAvailableBackends] = useState<BrowserBackend[]>([...BROWSER_BACKENDS]);
  const [browserBackendError, setBrowserBackendError] = useState<string | null>(null);
  const [egoReadiness, setEgoReadiness] = useState<EgoReadiness | null>(null);
  const [egoConnection, setEgoConnection] = useState<EgoConnection | null>(null);
  const [egoActivity, setEgoActivity] = useState(false);
  const [egoFrames, setEgoFrames] = useState(false);
  const [computerUse, setComputerUse] = useState(false);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDevice[]>([]);
  const [selectedRemoteDeviceId, setSelectedRemoteDeviceId] = useState<string | undefined>();
  const [pairingCommand, setPairingCommand] = useState<string | null>(null);
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [companionDownloadTemplate, setCompanionDownloadTemplate] = useState<string | null>(null);
  const [testingEgoConnection, setTestingEgoConnection] = useState(false);
  const [builtinBrowserStatus, setBuiltinBrowserStatus] = useState<string | null>(null);
  const selectedProjectId = useAppShellStore((state) => state.selectedProject?.projectId);
  const selectedSessionId = useAppShellStore((state) => state.selectedSession?.id);
  const builtinBrowserOwner = builtinBrowserOwnerId(selectedProjectId, selectedSessionId);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusResponse, grantsResponse, backendResponse, egoReadinessResponse, egoActivityResponse, computerUseResponse, remoteDevicesResponse] = await Promise.all([
        fetch('/api/automation/status'),
        fetch('/api/automation/grants'),
        fetch('/api/automation/browser-backend'),
        fetch('/api/automation/ego-readiness'),
        // Without a session id this reads the stored opt-in only; it never
        // observes a browser.
        fetch('/api/automation/ego-activity'),
        fetch('/api/automation/computer-use'),
        fetch('/api/automation/remote-computers'),
      ]);
      if (statusResponse.ok) setStatus(await statusResponse.json() as Status);
      if (grantsResponse.ok) setGrants(await grantsResponse.json() as Grants);
      if (backendResponse.ok) {
        const { backend, backends } = await backendResponse.json() as { backend: unknown; backends?: unknown };
        if (isBrowserBackend(backend)) setBrowserBackend(backend);
        if (Array.isArray(backends)) {
          const supported = backends.filter(isBrowserBackend);
          if (supported.length > 0) setAvailableBackends(supported);
        }
      }
      if (egoReadinessResponse.ok) setEgoReadiness(await egoReadinessResponse.json() as EgoReadiness);
      if (egoActivityResponse.ok) {
        const activity = await egoActivityResponse.json() as { configured?: boolean; framesConfigured?: boolean };
        setEgoActivity(activity.configured === true);
        setEgoFrames(activity.framesConfigured === true);
      }
      if (computerUseResponse.ok) {
        setComputerUse((await computerUseResponse.json() as { enabled?: boolean }).enabled === true);
      }
      if (remoteDevicesResponse.ok) {
        const remote = await remoteDevicesResponse.json() as { devices?: RemoteDevice[]; selectedDeviceId?: string; companionDownloadTemplate?: string };
        setRemoteDevices(Array.isArray(remote.devices) ? remote.devices : []);
        setSelectedRemoteDeviceId(remote.selectedDeviceId);
        setCompanionDownloadTemplate(typeof remote.companionDownloadTemplate === 'string' ? remote.companionDownloadTemplate : null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const changeBrowserBackend = async (backend: BrowserBackend) => {
    setBrowserBackendError(null);
    const response = await fetch('/api/automation/browser-backend', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    });
    if (!response.ok) {
      setBrowserBackendError(t('automation.browserBackend.saveFailed'));
      return;
    }
    const saved = await response.json() as { backend: unknown };
    if (isBrowserBackend(saved.backend)) setBrowserBackend(saved.backend);
  };

  const changeEgoActivity = async (enabled: boolean) => {
    setEgoActivity(enabled);
    const response = await fetch('/api/automation/ego-activity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      setEgoActivity(!enabled);
      return;
    }
    setEgoActivity((await response.json() as { enabled?: boolean }).enabled === true);
  };

  const changeEgoFrames = async (frames: boolean) => {
    setEgoFrames(frames);
    const response = await fetch('/api/automation/ego-activity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames }),
    });
    if (!response.ok) {
      setEgoFrames(!frames);
      return;
    }
    setEgoFrames((await response.json() as { frames?: boolean }).frames === true);
  };

  // Off by default (#131): the agent must not drive this Mac's applications
  // until the user says so here. A failed save leaves the switch where the
  // server left it.
  const changeComputerUse = async (enabled: boolean) => {
    setComputerUse(enabled);
    const response = await fetch('/api/automation/computer-use', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      setComputerUse(!enabled);
      return;
    }
    setComputerUse((await response.json() as { enabled?: boolean }).enabled === true);
  };

  const pairRemoteComputer = async () => {
    const response = await fetch('/api/automation/remote-computers/pairings', { method: 'POST' });
    if (!response.ok) return;
    const pairing = await response.json() as { token: string };
    const server = `${window.location.origin.replace(/^http/u, 'ws')}/remote-cua`;
    setPairingCommand(`gajae-cua://pair?server=${encodeURIComponent(server)}&token=${encodeURIComponent(pairing.token)}`);
    setPairingToken(pairing.token);
    setTokenCopied(false);
  };

  const copyPairingToken = async () => {
    if (!pairingToken) return;
    try {
      await navigator.clipboard.writeText(pairingToken);
      setTokenCopied(true);
    } catch { /* Clipboard access can be denied by the browser; the text stays selectable. */ }
  };

  const updateRemoteDevice = async (id: string, patch: { enabled?: boolean; name?: string }) => {
    const response = await fetch(`/api/automation/remote-computers/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (response.ok) await refresh();
  };

  const selectRemoteDevice = async (deviceId: string | undefined) => {
    const response = await fetch('/api/automation/remote-computers/selected', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }),
    });
    if (response.ok) await refresh();
  };

  const removeRemoteDevice = async (id: string) => {
    const response = await fetch(`/api/automation/remote-computers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.ok) await refresh();
  };

  const testEgoConnection = async () => {
    setTestingEgoConnection(true);
    setEgoConnection(null);
    try {
      const response = await fetch('/api/automation/ego-readiness/test', { method: 'POST' });
      const result = await response.json() as EgoConnection;
      setEgoConnection(result);
    } catch {
      setEgoConnection({ ok: false, status: 'failed', message: t('automation.browserBackend.connectionFailed') });
    } finally {
      setTestingEgoConnection(false);
    }
  };

  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);

  const revoke = async (kind: 'origin' | 'application', value: string) => {
    const response = await fetch('/api/automation/grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value, scope: 'always' }),
    });
    if (response.ok) setGrants(await response.json() as Grants);
  };

  const statusValue = (value: boolean | undefined) => value === true
    ? t('automation.granted')
    : value === false
      ? t('automation.missing')
      : t('automation.unknown');

  const allGrants = [
    ...(grants?.always.origins ?? []).map((value) => ({ kind: 'origin' as const, value })),
    ...(grants?.always.applications ?? []).map((value) => ({ kind: 'application' as const, value })),
  ];

  return (
    <div className="space-y-6">
      <SettingsSection title={t('automation.browserBackend.title')} description={t('automation.browserBackend.description')}>
        <SettingsCard>
          <SettingsRow label={t('automation.browserBackend.label')} description={t(`automation.browserBackend.${browserBackend ?? 'builtin'}Description`)}>
            <select
              aria-label={t('automation.browserBackend.label')}
              value={browserBackend ?? 'builtin'}
              disabled={browserBackend === null}
              onChange={(event) => { if (isBrowserBackend(event.target.value)) void changeBrowserBackend(event.target.value); }}
              className={`${selectClass} sm:w-48`}
            >
              {availableBackends.map((backend) => (
                <option key={backend} value={backend}>{t(`automation.browserBackend.${backend}`)}</option>
              ))}
            </select>
          </SettingsRow>
          {browserBackend === 'aside' ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">{t('automation.browserBackend.asideNote')}</p>
          ) : null}
          {browserBackend === 'ego' ? (
            <SettingsRow label={t('automation.browserBackend.activity')} description={t('automation.browserBackend.activityDescription')}>
              <SettingsToggle
                checked={egoActivity}
                onChange={(value) => void changeEgoActivity(value)}
                ariaLabel={t('automation.browserBackend.activity')}
              />
            </SettingsRow>
          ) : null}
          {browserBackend === 'ego' ? (
            <SettingsRow label={t('automation.browserBackend.activityFrame')} description={t('automation.browserBackend.activityFrameDescription')}>
              <SettingsToggle
                checked={egoFrames}
                onChange={(value) => void changeEgoFrames(value)}
                ariaLabel={t('automation.browserBackend.activityFrame')}
                disabled={!egoActivity}
              />
            </SettingsRow>
          ) : null}
          {browserBackend === 'ego' ? (
            <div className="space-y-2 px-4 pb-4 text-xs text-muted-foreground">
              <p>{t('automation.browserBackend.egoNote')}</p>
              <p>
                {t('automation.browserBackend.readiness')}: {t(`automation.browserBackend.readiness${egoReadiness?.status === 'ready' ? 'Ready' : egoReadiness?.status === 'not_ready' ? 'NotReady' : 'Unknown'}`)}
              </p>
              <button
                type="button"
                onClick={() => void testEgoConnection()}
                disabled={testingEgoConnection}
                className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testingEgoConnection ? t('automation.browserBackend.testingConnection') : t('automation.browserBackend.testConnection')}
              </button>
              {egoConnection ? (
                <p role="alert" className={egoConnection.ok ? 'text-muted-foreground' : 'text-destructive'}>
                  {egoConnection.ok
                    ? `${t('automation.browserBackend.connectionPassed')}${egoConnection.cliVersion ? ` (${egoConnection.cliVersion})` : ''}`
                    : egoConnection.message ?? t('automation.browserBackend.connectionFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
          {browserBackendError ? (
            <p className="px-4 pb-4 text-xs text-destructive" role="alert">{browserBackendError}</p>
          ) : null}
        </SettingsCard>

      </SettingsSection>

      {hasBuiltinBrowserBridge() ? (
        <SettingsSection title={t('automation.builtinBrowser.title')} description={t('automation.builtinBrowser.description')}>
          <SettingsCard>
            <SettingsRow label={t('automation.builtinBrowser.label')} description={t('automation.builtinBrowser.note')}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={status?.capabilities?.browser !== true || !builtinBrowserOwner}
                  className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setBuiltinBrowserStatus(null);
                    if (!builtinBrowserOwner) {
                      setBuiltinBrowserStatus(t('automation.builtinBrowser.errors.unavailable'));
                      return;
                    }
                    void openBuiltinBrowser(builtinBrowserOwner).then(
                      () => setBuiltinBrowserStatus(t('automation.builtinBrowser.opened')),
                      (error) => setBuiltinBrowserStatus(t(`automation.builtinBrowser.errors.${builtinBrowserFailure(error)}`)),
                    );
                  }}
                >
                  {t('automation.builtinBrowser.open')}
                </button>
              </div>
            </SettingsRow>
            {builtinBrowserStatus ? (
              <p className="px-4 pb-4 text-xs text-muted-foreground" role="status">{builtinBrowserStatus}</p>
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title={t('automation.title')} description={t('automation.description')}>
        <SettingsCard divided>
          <SettingsRow label={t('automation.computerUse.label')} description={t('automation.computerUse.description')}>
            <SettingsToggle
              checked={computerUse}
              onChange={(value) => void changeComputerUse(value)}
              ariaLabel={t('automation.computerUse.label')}
            />
          </SettingsRow>
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">CUA Driver</p>
              <p className="mt-1 text-xs text-muted-foreground">{status?.cua.installed ? `${status.cua.version ?? ''} · ${status.cua.daemon}` : t('automation.notInstalled')}</p>
            </div>
            <a href="https://cua.ai/docs/how-to-guides/driver/install" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              {t('automation.installGuide')} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="grid gap-2 p-4 text-xs text-muted-foreground sm:grid-cols-2">
            <span>{t('automation.accessibility')}: {statusValue(status?.cua.accessibility)}</span>
            <span>{t('automation.screenRecording')}: {statusValue(status?.cua.screenRecording)}</span>
          </div>
        </SettingsCard>
        <SettingsCard className="mt-3">
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Remote devices</p>
              <p className="mt-1 text-xs text-muted-foreground">Pair a laptop running the CUA companion. Only an enabled, currently connected device with a valid readiness report can be selected.</p>
            </div>
            <div className="flex items-center gap-2">
              {companionDownloadTemplate ? <a href={companionDownloadTemplate.replace('{platform}', companionPlatform())} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Download companion</a> : null}
              {companionDownloadTemplate && navigator.userAgent.includes('Mac')
                ? <a href={companionDownloadTemplate.replace('{platform}', companionMacCliPlatform())} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Download CLI</a>
                : null}
              <button type="button" onClick={() => void pairRemoteComputer()} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Pair this computer</button>
            </div>
          </div>
          {pairingCommand ? (
            <div className="border-t border-border p-4">
              <p className="mb-3 text-xs text-muted-foreground">This token expires in ten minutes and is shown only now.</p>
              <div className="flex flex-wrap gap-2">
                <a href={pairingCommand} className="inline-flex items-center gap-1 rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted"><ExternalLink className="h-3.5 w-3.5" />Open in companion</a>
                <button type="button" onClick={() => void copyPairingToken()} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">{tokenCopied ? 'Token copied' : 'Copy token'}</button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">“Open in companion” works with an already-running companion on Linux/Windows. On macOS (no GUI handler yet) or for a first run, copy the token and pass it to the companion with <code className="rounded bg-muted px-1">--pair=TOKEN</code>.</p>
            </div>
          ) : null}
          <div className="border-t border-border p-4">
            <label className="block text-xs text-muted-foreground" htmlFor="remote-computer-target">Computer target</label>
            <select id="remote-computer-target" className={`mt-2 w-full ${selectClass}`} value={selectedRemoteDeviceId ?? ''} onChange={(event) => void selectRemoteDevice(event.target.value || undefined)}>
              <option value="">Local driver</option>
              {remoteDevices.filter((device) => device.enabled && !device.revoked).map((device) => (
                <option key={device.id} value={device.id}>{device.name}</option>
              ))}
            </select>
          </div>
          {remoteDevices.length === 0 ? <p className="border-t border-border p-4 text-xs text-muted-foreground">No paired remote devices.</p> : remoteDevices.map((device) => {
            const ready = device.enabled && !device.revoked && Boolean(device.lastSeenAt) && device.readiness?.schemaSupported === true;
            const state = device.revoked ? 'Revoked' : !device.enabled ? 'Disabled' : !device.lastSeenAt ? 'Offline' : ready ? 'Ready' : 'CUA unsupported or permissions missing';
            return (
              <div key={device.id} className="border-t border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{device.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{device.os} · {state}{device.readiness?.driverVersion ? ` · CUA Driver ${device.readiness.driverVersion}` : ''}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={() => void updateRemoteDevice(device.id, { enabled: !device.enabled })} disabled={device.revoked} className="rounded border border-input px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50">{device.enabled ? 'Disable' : 'Enable'}</button>
                    <button type="button" onClick={() => {
                      const name = window.prompt('Remote device name', device.name);
                      if (name) void updateRemoteDevice(device.id, { name });
                    }} disabled={device.revoked} className="rounded border border-input px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50">Rename</button>
                    <button type="button" onClick={() => void removeRemoteDevice(device.id)} className="rounded border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10">Remove</button>
                  </div>
                </div>
              </div>
            );
          })}
        </SettingsCard>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('automation.refresh')}
        </button>
      </SettingsSection>

      <SettingsSection title={t('automation.grants')} description={t('automation.grantsDescription')}>
        <SettingsCard>
          {allGrants.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4" />{t('automation.noGrants')}</div>
          ) : allGrants.map((grant) => (
            <div key={`${grant.kind}:${grant.value}`} className="flex items-center justify-between gap-3 border-b border-border p-3 last:border-b-0">
              <div className="min-w-0"><p className="truncate text-sm text-foreground">{grant.value}</p><p className="text-xs text-muted-foreground">{t(`automation.${grant.kind}`)}</p></div>
              <button type="button" onClick={() => void revoke(grant.kind, grant.value)} aria-label={t('automation.revoke')} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>

    </div>
  );
}
