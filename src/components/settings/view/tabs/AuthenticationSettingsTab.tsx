import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type OidcConfig = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  redirectUri: string;
  allowedDomains: string[];
  allowedEmails: string[];
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
};

type Session = { email: string; name: string; expiresAt: number };

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const inputClass = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';

const emptyConfig: OidcConfig = {
  enabled: false,
  issuer: '',
  clientId: '',
  hasClientSecret: false,
  scopes: 'openid profile email',
  redirectUri: '',
  allowedDomains: [],
  allowedEmails: [],
};

export default function AuthenticationSettingsTab() {
  const { t } = useTranslation('settings');
  const [config, setConfig] = useState<OidcConfig>(emptyConfig);
  const [secret, setSecret] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSession = useCallback(async () => {
    const response = await authenticatedFetch('/api/auth/oidc/session');
    if (!response.ok) { setSession(null); return; }
    const body = await response.json() as { data?: Session };
    setSession(body.data ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await authenticatedFetch('/api/auth/oidc/config');
      if (response.ok) {
        const body = await response.json() as { data?: OidcConfig };
        if (body.data) setConfig(body.data);
      }
      await loadSession();
    })();
  }, [loadSession]);

  const patch = (changes: Partial<OidcConfig>) => setConfig((current) => ({ ...current, ...changes }));

  const save = async (changes: Partial<OidcConfig> = {}) => {
    setSaveState('saving');
    setError('');
    const response = await authenticatedFetch('/api/auth/oidc/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: config.enabled,
        issuer: config.issuer,
        clientId: config.clientId,
        scopes: config.scopes,
        redirectUri: config.redirectUri,
        allowedDomains: config.allowedDomains,
        allowedEmails: config.allowedEmails,
        ...(secret ? { clientSecret: secret } : {}),
        ...changes,
      }),
    });
    const body = await response.json() as { success?: boolean; data?: OidcConfig; error?: { message?: string } };
    if (!response.ok || !body.success) {
      setSaveState('error');
      setError(body.error?.message ?? t('authentication.saveFailed'));
      return;
    }
    if (body.data) setConfig(body.data);
    setSecret('');
    setSaveState('saved');
  };

  const discover = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await authenticatedFetch('/api/auth/oidc/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issuer: config.issuer }),
      });
      const body = await response.json() as { success?: boolean; data?: Discovery; error?: { message?: string } };
      if (!response.ok || !body.success) {
        setDiscovery(null);
        setError(body.error?.message ?? t('authentication.discoveryFailed'));
        return;
      }
      setDiscovery(body.data ?? null);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await authenticatedFetch('/api/auth/oidc/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await loadSession();
  };

  return (
    <>
      <SettingsSection title={t('authentication.title')}>
        <SettingsCard>
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('authentication.intro')}</p>
          <SettingsRow label={t('authentication.enabled')} description={t('authentication.enabledHint')}>
            <SettingsToggle
              checked={config.enabled}
              onChange={(enabled) => { patch({ enabled }); void save({ enabled }); }}
              ariaLabel={t('authentication.enabled')}
            />
          </SettingsRow>
          <SettingsRow label={t('authentication.issuer')} description={t('authentication.issuerHint')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.issuer} placeholder="https://auth.example.com"
              onChange={(event) => patch({ issuer: event.target.value })} />
          </SettingsRow>
          <SettingsRow label={t('authentication.clientId')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.clientId} onChange={(event) => patch({ clientId: event.target.value })} />
          </SettingsRow>
          <SettingsRow
            label={t('authentication.clientSecret')}
            description={config.hasClientSecret ? t('authentication.secretKept') : undefined}
            className="flex-col items-stretch gap-2"
          >
            <input className={inputClass} type="password" autoComplete="off" value={secret}
              placeholder={config.hasClientSecret ? '••••••••' : ''}
              onChange={(event) => setSecret(event.target.value)} />
          </SettingsRow>
          <SettingsRow label={t('authentication.scopes')} description={t('authentication.scopesHint')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.scopes} onChange={(event) => patch({ scopes: event.target.value })} />
          </SettingsRow>
          <SettingsRow label={t('authentication.redirectUri')} description={t('authentication.redirectUriHint')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.redirectUri} placeholder="https://app.example.com/api/auth/oidc/callback"
              onChange={(event) => patch({ redirectUri: event.target.value })} />
          </SettingsRow>
          <SettingsRow label={t('authentication.allowedDomains')} description={t('authentication.allowedHint')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.allowedDomains.join(', ')} placeholder="example.com"
              onChange={(event) => patch({ allowedDomains: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} />
          </SettingsRow>
          <SettingsRow label={t('authentication.allowedEmails')} className="flex-col items-stretch gap-2">
            <input className={inputClass} value={config.allowedEmails.join(', ')} placeholder="owner@example.com"
              onChange={(event) => patch({ allowedEmails: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} />
          </SettingsRow>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <button type="button" onClick={() => void discover()} disabled={busy || !config.issuer}
              className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              {t('authentication.discover')}
            </button>
            <button type="button" onClick={() => void save()} disabled={saveState === 'saving'}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {saveState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {t('authentication.save')}
            </button>
            {saveState === 'saved' && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />{t('authentication.saved')}
              </span>
            )}
            {error && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />{error}
              </span>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {discovery && (
        <SettingsSection title={t('authentication.endpoints')}>
          <SettingsCard>
            {(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'] as const).map((field) => (
              <SettingsRow key={field} label={field} className="flex-col items-stretch gap-2">
                <code className="block rounded-lg bg-muted/40 px-3 py-2 text-xs break-all text-muted-foreground">
                  {discovery[field] ?? '—'}
                </code>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection title={t('authentication.session')}>
        <SettingsCard>
          <SettingsRow
            label={session ? t('authentication.signedInAs', { email: session.email }) : t('authentication.signedOut')}
            description={session ? new Date(session.expiresAt).toLocaleString() : t('authentication.sessionHint')}
          >
            {session
              ? <button type="button" onClick={() => void signOut()}
                className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm font-medium">
                <LogOut className="h-4 w-4" aria-hidden />{t('authentication.signOut')}
              </button>
              : <a href="/api/auth/oidc/start" className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" aria-hidden />{t('authentication.signIn')}
              </a>}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
