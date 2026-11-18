import { Bell, BellOff, BellRing, Loader2, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { WebPushState } from '../../../../hooks/useWebPush';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type { NotificationPreferencesState } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  isDesktop?: boolean;
  desktopNotifications?: { enabled: boolean; supported: boolean; connectedCount?: number; targetCount?: number; lastError?: string | null } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
  webPush?: WebPushState | null;
  onSubscribeWebPush?: () => void;
  onUnsubscribeWebPush?: () => void;
  onTestWebPush?: () => void;
};
type EventName = keyof NotificationPreferencesState['events'];

type TelegramSettings = {
  enabled: boolean;
  hasBotToken: boolean;
  chatId: string;
  sound: 'all' | 'important' | 'none';
  rich: boolean;
  richDraft: boolean;
  streaming: boolean;
  toolActivity: boolean;
};
type GjcSettings = {
  enabled: boolean;
  telegram: TelegramSettings;
  redact: boolean;
  verbosity: 'lean' | 'verbose';
  sessionScope: 'all' | 'primary';
};

const inputClass = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';
const TOKEN_MASK = '••••••••••••••••••••';
const selectClass = `${inputClass} py-2`;

const emptyGjcSettings: GjcSettings = {
  enabled: false,
  telegram: {
    enabled: false,
    hasBotToken: false,
    chatId: '',
    sound: 'all',
    rich: true,
    richDraft: false,
    streaming: true,
    toolActivity: false,
  },
  redact: false,
  verbosity: 'lean',
  sessionScope: 'all',
};

function EventCheckbox({ event, label, preferences, onChange }: {
  event: EventName;
  label: string;
  preferences: NotificationPreferencesState;
  onChange: (value: NotificationPreferencesState) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={preferences.events[event]}
        onChange={(input) => onChange({
          ...preferences,
          events: { ...preferences.events, [event]: input.target.checked },
        })}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}

/**
 * Push and sound are one section: the sound is how a push announces itself on
 * this device, so a separate switch elsewhere read as a second, unrelated
 * notification channel.
 */
function PushAndSoundCard({ webPush, preferences, onPreferencesChange, onSubscribe, onUnsubscribe, onTest }: {
  webPush?: WebPushState | null;
  preferences: NotificationPreferencesState;
  onPreferencesChange: (value: NotificationPreferencesState) => void;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
  onTest?: () => void;
}) {
  const { t } = useTranslation('settings');
  const pushAvailable = Boolean(webPush && (webPush.supported || webPush.requiresHomeScreenInstall || webPush.requiresSecureContext));
  const denied = webPush?.permission === 'denied';
  return (
    <SettingsSection
      title={pushAvailable ? t('notifications.webPush.title') : t('notifications.sound.title', { defaultValue: 'Sound' })}
      description={pushAvailable
        ? t('notifications.webPush.description')
        : t('notifications.sound.description', { defaultValue: 'Play a short tone when a chat run finishes.' })}
    >
      <SettingsCard divided>
        {pushAvailable && webPush ? (
          webPush.requiresSecureContext ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('notifications.webPush.httpsRequired')}</p>
          ) : webPush.requiresHomeScreenInstall ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('notifications.webPush.installFirst')}</p>
          ) : denied ? (
            <p className="px-4 py-4 text-sm text-destructive">{t('notifications.webPush.denied')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3 px-4 py-4">
              <button
                type="button"
                disabled={webPush.busy}
                onClick={webPush.subscribed ? onUnsubscribe : onSubscribe}
                className={webPush.subscribed
                  ? 'inline-flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-60'
                  : 'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60'}
              >
                {webPush.subscribed ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
                {webPush.subscribed ? t('notifications.webPush.disable') : t('notifications.webPush.enable')}
              </button>
              {webPush.subscribed && (
                <Button type="button" variant="outline" size="sm" onClick={onTest}>
                  {t('notifications.webPush.test')}
                </Button>
              )}
            </div>
          )
        ) : null}
        {webPush?.error && <p className="px-4 pb-4 text-sm text-destructive">{t('notifications.webPush.failed', { reason: webPush.error })}</p>}
        <SettingsRow label={t('notifications.sound.title', { defaultValue: 'Sound' })}>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { void playChatCompletionSound({ force: true }); }}>
              <Play className="h-4 w-4" aria-hidden />
              {t('notifications.sound.test', { defaultValue: 'Test sound' })}
            </Button>
            <SettingsToggle
              checked={preferences.channels.sound}
              onChange={(sound) => onPreferencesChange({ ...preferences, channels: { ...preferences.channels, sound } })}
              ariaLabel={t('notifications.sound.title', { defaultValue: 'Sound' })}
            />
          </div>
        </SettingsRow>
        {/* The events are what a push is sent for, so they belong to the same
            card: a separate section read as a second notification channel. */}
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs font-medium text-foreground">{t('notifications.events.title')}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <EventCheckbox event="actionRequired" label={t('notifications.events.actionRequired')} preferences={preferences} onChange={onPreferencesChange} />
            <EventCheckbox event="stop" label={t('notifications.events.stop')} preferences={preferences} onChange={onPreferencesChange} />
            <EventCheckbox event="error" label={t('notifications.events.error')} preferences={preferences} onChange={onPreferencesChange} />
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * The CLI's own notification channels. These live in the agent's config.yml,
 * not in the app database, so the same numbers and switches apply whether a run
 * was started here or from a terminal.
 */
function GjcNotificationsCard() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<GjcSettings>(emptyGjcSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [botToken, setBotToken] = useState('');
  // The stored token is never sent back, so the empty field looked unset. A
  // mask fills it until the field is focused; typing replaces it, and leaving
  // it untouched keeps the stored value.
  const [tokenFocused, setTokenFocused] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/notifications/gjc');
      const body = await response.json() as { data?: GjcSettings; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? t('notifications.gjc.loadFailed'));
      setSettings(body.data);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('notifications.gjc.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const patchTelegram = (changes: Partial<TelegramSettings>) => {
    setSaved(false);
    setTestResult(null);
    setSettings((current) => ({ ...current, telegram: { ...current.telegram, ...changes } }));
  };
  const patch = (changes: Partial<GjcSettings>) => {
    setSaved(false);
    setTestResult(null);
    setSettings((current) => ({ ...current, ...changes }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await authenticatedFetch('/api/notifications/gjc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, telegram: { ...settings.telegram, botToken: botToken.trim() } }),
      });
      const body = await response.json() as { data?: GjcSettings; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? t('notifications.gjc.saveFailed'));
      setSettings(body.data);
      setBotToken('');
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('notifications.gjc.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // The test sends what the form currently shows, so a token can be proven
  // before it is saved; blank fields fall back to the stored values server-side.
  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await authenticatedFetch('/api/notifications/gjc/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken.trim(), chatId: settings.telegram.chatId.trim() }),
      });
      const body = await response.json() as {
        data?: { delivered?: boolean; enabled?: boolean; telegramEnabled?: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !body.data?.delivered) {
        throw new Error(t('notifications.gjc.testFailed', { reason: body.error?.message ?? String(response.status) }));
      }
      // A delivered test with delivery switched off is the usual reason a
      // working bot still says nothing during a run.
      const off = !body.data.enabled || !body.data.telegramEnabled;
      setTestResult({ ok: true, message: off ? t('notifications.gjc.testOff') : t('notifications.gjc.testSent') });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : t('notifications.gjc.testFailed', { reason: String(error) }),
      });
    } finally {
      setTesting(false);
    }
  };

  const telegram = settings.telegram;
  const canTest = Boolean((telegram.hasBotToken || botToken.trim()) && telegram.chatId.trim());

  return (
    <SettingsSection title={t('notifications.gjc.title')} description={t('notifications.gjc.description')}>
      <SettingsCard divided>
        {loading ? (
          <p role="status" className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('common.loading', { defaultValue: 'Loading…' })}
          </p>
        ) : (
          <>
            <SettingsRow label={t('notifications.gjc.enabled')} description={t('notifications.gjc.enabledHint')}>
              <SettingsToggle
                checked={settings.enabled}
                onChange={(enabled) => patch({ enabled })}
                ariaLabel={t('notifications.gjc.enabled')}
              />
            </SettingsRow>

            <SettingsRow label={t('notifications.gjc.telegramEnabled')} description={t('notifications.gjc.telegramTitle')}>
              <SettingsToggle
                checked={telegram.enabled}
                onChange={(enabled) => patchTelegram({ enabled })}
                ariaLabel={t('notifications.gjc.telegramEnabled')}
              />
            </SettingsRow>
            <SettingsRow
              label={t('notifications.gjc.botToken')}
              description={telegram.hasBotToken ? t('notifications.gjc.botTokenSet') : undefined}
              className="flex-col items-stretch gap-2"
            >
              <input
                type="password"
                autoComplete="off"
                value={botToken || (telegram.hasBotToken && !tokenFocused ? TOKEN_MASK : '')}
                placeholder={t('notifications.gjc.botTokenPlaceholder')}
                aria-label={t('notifications.gjc.botToken')}
                onFocus={() => setTokenFocused(true)}
                onBlur={() => setTokenFocused(false)}
                onChange={(event) => { setSaved(false); setTestResult(null); setBotToken(event.target.value); }}
                className={inputClass}
              />
            </SettingsRow>
            <SettingsRow label={t('notifications.gjc.chatId')} className="flex-col items-stretch gap-2">
              <input
                value={telegram.chatId}
                placeholder={t('notifications.gjc.chatIdPlaceholder')}
                aria-label={t('notifications.gjc.chatId')}
                onChange={(event) => patchTelegram({ chatId: event.target.value })}
                className={inputClass}
              />
            </SettingsRow>
            <SettingsRow label={t('notifications.gjc.sound')} className="flex-col items-stretch gap-2">
              <select
                value={telegram.sound}
                aria-label={t('notifications.gjc.sound')}
                onChange={(event) => patchTelegram({ sound: event.target.value as TelegramSettings['sound'] })}
                className={selectClass}
              >
                <option value="all">{t('notifications.gjc.soundAll')}</option>
                <option value="important">{t('notifications.gjc.soundImportant')}</option>
                <option value="none">{t('notifications.gjc.soundNone')}</option>
              </select>
            </SettingsRow>
            {([
              ['rich', t('notifications.gjc.rich')],
              ['richDraft', t('notifications.gjc.richDraft')],
              ['streaming', t('notifications.gjc.streaming')],
              ['toolActivity', t('notifications.gjc.toolActivity')],
            ] as const).map(([key, label]) => (
              <SettingsRow key={key} label={label}>
                <SettingsToggle
                  checked={telegram[key]}
                  onChange={(value) => patchTelegram({ [key]: value })}
                  ariaLabel={label}
                />
              </SettingsRow>
            ))}

            <SettingsRow label={t('notifications.gjc.redact')} description={t('notifications.gjc.redactHint')}>
              <SettingsToggle
                checked={settings.redact}
                onChange={(redact) => patch({ redact })}
                ariaLabel={t('notifications.gjc.redact')}
              />
            </SettingsRow>
            <SettingsRow label={t('notifications.gjc.verbosity')} className="flex-col items-stretch gap-2">
              <select
                value={settings.verbosity}
                aria-label={t('notifications.gjc.verbosity')}
                onChange={(event) => patch({ verbosity: event.target.value as GjcSettings['verbosity'] })}
                className={selectClass}
              >
                <option value="lean">{t('notifications.gjc.verbosityLean')}</option>
                <option value="verbose">{t('notifications.gjc.verbosityVerbose')}</option>
              </select>
            </SettingsRow>
            <SettingsRow label={t('notifications.gjc.sessionScope')} className="flex-col items-stretch gap-2">
              <select
                value={settings.sessionScope}
                aria-label={t('notifications.gjc.sessionScope')}
                onChange={(event) => patch({ sessionScope: event.target.value as GjcSettings['sessionScope'] })}
                className={selectClass}
              >
                <option value="all">{t('notifications.gjc.scopeAll')}</option>
                <option value="primary">{t('notifications.gjc.scopePrimary')}</option>
              </select>
            </SettingsRow>

            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
                {saving ? t('notifications.gjc.saving') : t('notifications.gjc.save')}
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void sendTest()}
                disabled={testing || saving || !canTest}
                title={canTest ? undefined : t('notifications.gjc.testNeedsConfig')}
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                {testing ? t('notifications.gjc.testing') : t('notifications.gjc.test')}
              </Button>
              {saved && <span className="text-xs text-muted-foreground">{t('notifications.gjc.saved')}</span>}
              {testResult && (
                <span className={testResult.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
                  {testResult.message}
                </span>
              )}
              {error && <span className="text-xs text-destructive">{error}</span>}
            </div>
          </>
        )}
        {error && loading ? <p className="px-4 pb-4 text-sm text-destructive">{error}</p> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export default function NotificationsSettingsTab(props: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { notificationPreferences: preferences, onNotificationPreferencesChange: changePreferences } = props;
  const desktopEnabled = props.desktopNotifications?.enabled;
  const toggleDesktop = () => {
    if (desktopEnabled) {
      props.onDisableDesktopNotifications?.();
    } else {
      props.onEnableDesktopNotifications?.();
    }
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" aria-hidden />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      {props.isDesktop ? (
        <SettingsSection title={t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}>
          <SettingsCard>
            {props.desktopNotifications?.supported === false ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })}
              </p>
            ) : (
              <SettingsRow
                label={desktopEnabled
                  ? t('notifications.desktop.enabled', { defaultValue: 'Desktop notifications are enabled' })
                  : t('notifications.desktop.enable', { defaultValue: 'Enable desktop notifications' })}
                description={props.desktopNotifications?.lastError ?? undefined}
              >
                <SettingsToggle
                  checked={Boolean(desktopEnabled)}
                  onChange={toggleDesktop}
                  ariaLabel={t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
                />
              </SettingsRow>
            )}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <PushAndSoundCard
        webPush={props.webPush}
        preferences={preferences}
        onPreferencesChange={changePreferences}
        onSubscribe={props.onSubscribeWebPush}
        onUnsubscribe={props.onUnsubscribeWebPush}
        onTest={props.onTestWebPush}
      />

      <GjcNotificationsCard />
    </div>
  );
}
