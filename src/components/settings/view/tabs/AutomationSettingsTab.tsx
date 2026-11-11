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
  connected?: boolean;
  lastSeenAt?: number;
  readiness?: {
    driverVersion?: string;
    schemaSupported: boolean;
    daemon: 'running' | 'stopped' | 'unknown';
    accessibility?: boolean;
    screenRecording?: boolean;
  };
};

type HostCapabilityKey = 'facts' | 'containers' | 'restart' | 'discovery' | 'docker' | 'shell' | 'files';

type HostControlPatch = Partial<{ enabled: boolean; targets: string[] } & Record<HostCapabilityKey, boolean>>;

type HostControl = {
  available: boolean;
  socketPath: string;
  reachable: boolean;
  enabled: boolean;
  capabilities: Record<HostCapabilityKey, boolean>;
  targets: string[];
  /** The last saved detection, so the OS line survives a reload. */
  host: { os: string; kernelVersion: string; detectedAt: number } | null;
};

type HostDiscoveryProfile = {
  runtime: { serverVersion: string; operatingSystem: string; kernelVersion: string; driver: string; swarm: string; hostName: string };
  managers: Array<{ id: string; label: string; evidence: string[] }>;
  socketHolders: string[];
  stacks: Array<{ project: string; services: string[]; containers: string[] }>;
  unmanaged: string[];
  guidance: string[];
};

// Reading is one switch here: Docker's own facts and the derived "what is
// managing this host" answer are the same two reads, so they turn on together.
const HOST_READ: readonly HostCapabilityKey[] = ['facts', 'discovery'];

// Everything that acts on containers, under one group switch. Each row stays
// its own permission on the server; this only sets all five at once.
const DOCKER_ROWS: readonly HostCapabilityKey[] = ['containers', 'restart', 'docker', 'shell', 'files'];

// The daemon already reports the distro's pretty name ("Debian GNU/Linux 12
// (bookworm)"), properly capitalised. Rewriting it would produce "Debian
// Gnu/linux", so it is shown as reported; the kernel is the fallback for a
// daemon that names no OS at all.
function describeHostOs(profile: HostDiscoveryProfile): string {
  const os = profile.runtime.operatingSystem.trim();
  if (os.length > 0) return os;
  return profile.runtime.kernelVersion.trim();
}

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
  const [hostControl, setHostControl] = useState<HostControl | null>(null);
  const [targetsDraft, setTargetsDraft] = useState('');
  const [hostControlError, setHostControlError] = useState<string | null>(null);
  const [detectedOs, setDetectedOs] = useState<string | null>(null);
  const [detectingHost, setDetectingHost] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDevice[]>([]);
  const [selectedRemoteDeviceId, setSelectedRemoteDeviceId] = useState<string | undefined>();
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [pairingDeepLink, setPairingDeepLink] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [companionDownloadTemplate, setCompanionDownloadTemplate] = useState<string | null>(null);
  const [testingEgoConnection, setTestingEgoConnection] = useState(false);
  const [builtinBrowserStatus, setBuiltinBrowserStatus] = useState<string | null>(null);
  const selectedProjectId = useAppShellStore((state) => state.selectedProject?.projectId);
  const selectedSessionId = useAppShellStore((state) => state.selectedSession?.id);
  const builtinBrowserOwner = builtinBrowserOwnerId(selectedProjectId, selectedSessionId);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusResponse, grantsResponse, backendResponse, egoReadinessResponse, egoActivityResponse, computerUseResponse, remoteDevicesResponse, hostControlResponse] = await Promise.all([
        fetch('/api/automation/status'),
        fetch('/api/automation/grants'),
        fetch('/api/automation/browser-backend'),
        fetch('/api/automation/ego-readiness'),
        // Without a session id this reads the stored opt-in only; it never
        // observes a browser.
        fetch('/api/automation/ego-activity'),
        fetch('/api/automation/computer-use'),
        fetch('/api/automation/remote-computers'),
        fetch('/api/host/status'),
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
      if (hostControlResponse.ok) setHostControl(await hostControlResponse.json() as HostControl);
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

  // Host control is saved server-side and re-read, so the switches always show
  // what the server will actually enforce.
  const saveHostControl = async (patch: HostControlPatch) => {
    const response = await fetch('/api/host/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      // The draft must not look saved when the server kept the old scope.
      setHostControlError(t('automation.hostControl.saveFailed'));
      if (hostControl) setTargetsDraft(hostControl.targets.join(', '));
      return;
    }
    setHostControlError(null);
    setHostControl(await response.json() as HostControl);
  };

  // Discovery answers "what is actually running this host". The server keeps
  // the answer, so this only has to show the part the operator asked for: the
  // OS. Everything else is there for the agent through /api/host/status.
  const detectHostEnvironment = async () => {
    setDetectingHost(true);
    setDetectError(null);
    try {
      const response = await fetch('/api/host/discovery');
      if (!response.ok) {
        setDetectError(t('automation.hostControl.detectFailed'));
        return;
      }
      const { profile } = await response.json() as { profile: HostDiscoveryProfile };
      setDetectedOs(describeHostOs(profile));
    } catch {
      setDetectError(t('automation.hostControl.detectFailed'));
    } finally {
      setDetectingHost(false);
    }
  };

  const pairRemoteComputer = async () => {
    const response = await fetch('/api/automation/remote-computers/pairings', { method: 'POST' });
    if (!response.ok) return;
    const pairing = await response.json() as { token: string };
    const server = `${window.location.origin.replace(/^http/u, 'ws')}/remote-cua`;
    // No OS protocol handler is registered by the Rust companion rewrite
    // (the old --register-protocol flag was never ported), so this link
    // only ever does anything once that ships; kept so the control exists
    // rather than disappearing, with the always-working copyable command
    // beside it for right now.
    setPairingDeepLink(`gajae-cua://pair?server=${encodeURIComponent(server)}&token=${encodeURIComponent(pairing.token)}`);
    setPairingToken(pairing.token);
    setTokenCopied(false);
    setCommandCopied(false);
  };

  const companionPairCommand = (token: string) =>
    `./gajae-agent-desktop-companion --server=${window.location.hostname} --pair=${token}`;

  const copyPairingToken = async () => {
    if (!pairingToken) return;
    try {
      await navigator.clipboard.writeText(pairingToken);
      setTokenCopied(true);
    } catch { /* Clipboard access can be denied by the browser; the text stays selectable. */ }
  };

  const copyPairingCommand = async () => {
    if (!pairingToken) return;
    try {
      await navigator.clipboard.writeText(companionPairCommand(pairingToken));
      setCommandCopied(true);
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

  // The server is the scope of record; the field only edits a draft of it.
  useEffect(() => {
    if (hostControl) setTargetsDraft(hostControl.targets.join(', '));
  }, [hostControl]);

  // A companion that just registered (--pair or plain --server) needs this
  // page to show up as "needs approval" or online without a manual reload.
  // The server pushes an SSE 'changed' event the instant a device connects,
  // registers, is approved, disconnects, or reports readiness - subscribed
  // here for the instant path. A reverse proxy that holds an event stream
  // open without ever flushing an event (confirmed via the proxy's own access
  // log: the request is 200 but only the stream's 5-byte preamble ever
  // arrives) leaves the online bubble stale, so this also re-reads the same
  // cheap endpoint on a slow interval while the tab is visible. SSE still
  // wins whenever it delivers; the poll is the floor. A full refresh()
  // (status/grants/ego/etc. too) still runs on mount and on every action.
  useEffect(() => {
    const refreshRemoteDevices = async () => {
      try {
        const response = await fetch('/api/automation/remote-computers');
        if (!response.ok) return;
        const remote = await response.json() as { devices?: RemoteDevice[]; selectedDeviceId?: string };
        if (Array.isArray(remote.devices)) setRemoteDevices(remote.devices);
        setSelectedRemoteDeviceId(remote.selectedDeviceId);
      } catch { /* Transient network hiccup; the next event or poll retries. */ }
    };
    const source = typeof EventSource === 'undefined'
      ? null
      : new EventSource('/api/automation/remote-computers/events');
    source?.addEventListener('changed', () => void refreshRemoteDevices());
    // Only while the tab is visible, so a backgrounded Settings tab does not
    // keep re-reading an endpoint nobody is looking at.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshRemoteDevices();
    }, 2_000);
    // A tab that was hidden, or a window that just regained focus, is exactly
    // when the cached view is oldest - re-read immediately instead of waiting
    // out the next poll tick.
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') void refreshRemoteDevices();
    };
    document.addEventListener('visibilitychange', refreshOnVisible);
    window.addEventListener('focus', refreshOnVisible);
    // EventSource auto-reconnects on its own after a drop; nothing else to
    // do here beyond closing it on unmount.
    return () => {
      source?.close();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', refreshOnVisible);
      window.removeEventListener('focus', refreshOnVisible);
    };
  }, []);


  const revoke = async (kind: 'origin' | 'application', value: string) => {
    const response = await fetch('/api/automation/grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value, scope: 'always' }),
    });
    if (response.ok) setGrants(await response.json() as Grants);
  };

  const allGrants = [
    ...(grants?.always.origins ?? []).map((value) => ({ kind: 'origin' as const, value })),
    ...(grants?.always.applications ?? []).map((value) => ({ kind: 'application' as const, value })),
  ];

  const hostReadOn = hostControl !== null && HOST_READ.every((capability) => hostControl.capabilities[capability] === true);
  // On when anything below is on: the group only reveals its rows, so it must
  // not read "off" while one of those rows is still granting something.
  const dockerGroupOn = hostControl !== null && DOCKER_ROWS.some((capability) => hostControl.capabilities[capability] === true);
  const shownOs = detectedOs ?? hostControl?.host?.os ?? null;

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

      {/* Its own section, not a row buried in the browser card: host control
         is the one switch here that reaches the machine the app runs on.
         It renders even when /api/host/status could not be read, because a
         row that silently disappears reads as "this build has no such
         setting" - which is what a LAN session that has not signed in sees,
         since host control is not exempt from the sign-in gate. */}
      <SettingsSection title={t('automation.hostControl.label')} description={t('automation.hostControl.description')}>
        <SettingsCard divided>
          <SettingsRow label={t('automation.hostControl.enableLabel')} description={t('automation.hostControl.enableDescription')}>
            <SettingsToggle
              checked={hostControl?.enabled === true}
              disabled={hostControl?.available !== true}
              onChange={(value) => void saveHostControl({ enabled: value })}
              ariaLabel={t('automation.hostControl.enableLabel')}
            />
          </SettingsRow>
          {hostControl === null ? (
            // Not role="status": this note is a standing explanation, and the
            // browser-launch status line is the only live one on the tab.
            <p className="px-4 py-3 text-xs text-muted-foreground">{t('automation.hostControl.statusFailed')}</p>
          ) : hostControl.available ? (
            <p className="px-4 py-3 text-xs text-muted-foreground" role="status">
              {hostControl.reachable
                ? t('automation.hostControl.socketReachable', { path: hostControl.socketPath })
                : t('automation.hostControl.socketUnreachable', { path: hostControl.socketPath })}
            </p>
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">{t('automation.hostControl.unavailable')}</p>
          )}
          {hostControl?.available === true && hostControl.enabled ? (
            <>
              {/* One row, one right-hand cluster: the button that refreshes the
                 answer sits left of the switch that permits it, and the answer
                 itself takes the description slot once it is known, so it lines
                 up with the text of every other row instead of floating in a
                 strip of its own. */}
              <SettingsRow
                label={t('automation.hostControl.hostInfo')}
                description={!detectingHost && shownOs
                  ? <span role="status" className="font-medium text-foreground">{shownOs}</span>
                  : t('automation.hostControl.hostInfoDescription')}
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void detectHostEnvironment()}
                    disabled={detectingHost || !hostReadOn}
                    className="rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {detectingHost ? t('automation.hostControl.detecting') : t('automation.hostControl.detect')}
                  </button>
                  <SettingsToggle
                    checked={hostReadOn}
                    onChange={(value) => void saveHostControl({ facts: value, discovery: value })}
                    ariaLabel={t('automation.hostControl.hostInfo')}
                  />
                </div>
              </SettingsRow>
              {/* The group sits level with every other row; only its rows are
                 inset, under a rule, so the nesting is visible without
                 pushing the group itself to the right. Turned off, it hides
                 them and takes their grants with it. */}
              <SettingsRow label={t('automation.hostControl.dockerGroup')} description={t('automation.hostControl.dockerGroupDescription')}>
                <SettingsToggle
                  checked={dockerGroupOn}
                  onChange={(value) => void saveHostControl(
                    Object.fromEntries(DOCKER_ROWS.map((capability) => [capability, value])) as HostControlPatch,
                  )}
                  ariaLabel={t('automation.hostControl.dockerGroup')}
                />
              </SettingsRow>
              {dockerGroupOn ? (
                <div className="bg-muted/20 py-1">
                  <div className="ml-4 border-l border-border pl-1">
                    {DOCKER_ROWS.map((capability) => (
                      <SettingsRow
                        key={capability}
                        className="py-3"
                        label={t(`automation.hostControl.${capability}`)}
                        description={t(`automation.hostControl.${capability}Description`)}
                      >
                        <SettingsToggle
                          checked={hostControl.capabilities[capability] === true}
                          onChange={(value) => void saveHostControl({ [capability]: value } as HostControlPatch)}
                          ariaLabel={t(`automation.hostControl.${capability}`)}
                        />
                      </SettingsRow>
                    ))}
                  </div>
                </div>
              ) : null}
              {/* The scope for everything that reaches further than a restart:
                 state changes, commands and file reads only touch containers
                 this list names. Empty means none, not all of them. */}
              <SettingsRow label={t('automation.hostControl.targets')} description={t('automation.hostControl.targetsDescription')}>
                <input
                  aria-label={t('automation.hostControl.targets')}
                  value={targetsDraft}
                  placeholder={t('automation.hostControl.targetsPlaceholder')}
                  onChange={(event) => setTargetsDraft(event.target.value)}
                  onBlur={() => {
                    const patterns = targetsDraft.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
                    if (patterns.join('\u0000') !== hostControl.targets.join('\u0000')) void saveHostControl({ targets: patterns });
                  }}
                  className={`${selectClass} sm:w-64`}
                />
              </SettingsRow>
              {hostControlError ? <p role="alert" className="px-4 py-3 text-xs text-destructive">{hostControlError}</p> : null}
              {detectError ? <p role="alert" className="px-4 py-3 text-xs text-destructive">{detectError}</p> : null}
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('automation.title')} description={t('automation.description')}>
        <SettingsCard divided>
          <SettingsRow label={t('automation.computerUse.label')} description={t('automation.computerUse.description')}>
            <SettingsToggle
              checked={computerUse}
              onChange={(value) => void changeComputerUse(value)}
              ariaLabel={t('automation.computerUse.label')}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard className="mt-3">
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Remote devices</p>
              <p className="mt-1 text-xs text-muted-foreground">Pair a device running the agent-desktop companion, or run it with only --server and no token at all - either way a new device needs to be Trusted below before it can be selected, and only a trusted, currently connected device with a valid readiness report can actually run anything. Untrust pauses a device without deleting it; Remove deletes it outright (it can always reconnect and register again afterward).</p>
            </div>
            <div className="flex items-center gap-2">
              {companionDownloadTemplate ? <a href={companionDownloadTemplate.replace('{platform}', companionPlatform())} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Download companion</a> : null}
              {companionDownloadTemplate && navigator.userAgent.includes('Mac')
                ? <a href={companionDownloadTemplate.replace('{platform}', companionMacCliPlatform())} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Download CLI</a>
                : null}
              <button type="button" onClick={() => void pairRemoteComputer()} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">Pair this computer</button>
            </div>
          </div>
          {pairingToken ? (
            <div className="border-t border-border p-4">
              <p className="mb-3 text-xs text-muted-foreground">This token expires in ten minutes and is shown only now. Run the companion with it on the device you want to pair:</p>
              <div className="flex flex-wrap items-center gap-2">
                {pairingDeepLink ? <a href={pairingDeepLink} className="inline-flex items-center gap-1 rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted"><ExternalLink className="h-3.5 w-3.5" />Open in companion</a> : null}
                <button type="button" onClick={() => void copyPairingToken()} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">{tokenCopied ? 'Token copied' : 'Copy token'}</button>
                <button type="button" onClick={() => void copyPairingCommand()} className="rounded-lg border border-input px-3 py-2 text-xs text-foreground hover:bg-muted">{commandCopied ? 'Command copied' : 'Copy command'}</button>
              </div>
              <code className="mt-2 block overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs text-foreground">{companionPairCommand(pairingToken)}</code>
              <p className="mt-2 text-xs text-muted-foreground">"Open in companion" requires an OS protocol handler the companion does not register yet - use the token or command for now. The device will appear below once it connects, and needs to be Trusted here before it can run anything.</p>
            </div>
          ) : null}
          <div className="border-t border-border p-4">
            <label className="block text-xs text-muted-foreground" htmlFor="remote-computer-target">Computer target</label>
            <select id="remote-computer-target" className={`mt-2 w-full ${selectClass}`} value={selectedRemoteDeviceId ?? ''} onChange={(event) => void selectRemoteDevice(event.target.value || undefined)}>
              <option value="">Local driver</option>
              {remoteDevices.filter((device) => device.enabled).map((device) => (
                <option key={device.id} value={device.id}>{device.name}</option>
              ))}
            </select>
          </div>
          {remoteDevices.length === 0 ? <p className="border-t border-border p-4 text-xs text-muted-foreground">No paired remote devices.</p> : remoteDevices.map((device) => {
            // `connected` is the live socket state and is what "online" means.
            // `lastSeenAt` only moves when a readiness report arrives, so
            // reading it as the liveness signal showed a freshly connected but
            // still probing companion as "Offline" - the state the user then
            // had to refresh the page to clear.
            const state = !device.enabled
              ? (device.connected ? 'Connected - needs approval' : 'Needs approval')
              : !device.connected
                ? 'Offline'
                : device.readiness?.schemaSupported === true
                  ? 'Ready'
                  : device.readiness
                    ? 'agent-desktop unsupported or permissions missing'
                    : 'Connected - checking agent-desktop';
            return (
              <div key={device.id} className="border-t border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${device.connected ? 'bg-emerald-500' : 'bg-destructive'}`}
                        role="img"
                        aria-label={device.connected ? 'Companion online' : 'Companion offline'}
                        title={device.connected ? 'Companion online' : 'Companion offline'}
                      />
                      <span className="truncate">{device.name}</span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{device.os} · {state}{device.readiness?.driverVersion ? ` · agent-desktop ${device.readiness.driverVersion}` : ''}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {/* Same two verbs always mean the same thing: Trust/
                       Untrust is the one toggle, Remove is the one delete -
                       it never relabels itself to Decline depending on
                       whether the device happened to be trusted yet, which
                       was confusing (the delete action is identical either
                       way: it deletes the record outright). */}
                    <button type="button" onClick={() => void updateRemoteDevice(device.id, { enabled: !device.enabled })} className={`rounded border px-2 py-1 text-xs hover:bg-muted ${device.enabled ? 'border-input text-foreground' : 'border-emerald-600 text-emerald-600'}`}>{device.enabled ? 'Untrust' : 'Trust'}</button>
                    <button type="button" onClick={() => {
                      const name = window.prompt('Remote device name', device.name);
                      if (name) void updateRemoteDevice(device.id, { name });
                    }} className="rounded border border-input px-2 py-1 text-xs text-foreground hover:bg-muted">Rename</button>
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
