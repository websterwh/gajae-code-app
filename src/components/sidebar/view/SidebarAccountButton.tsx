import { useEffect, useState } from 'react';
import { CircleUser, LogIn, ShieldCheck } from 'lucide-react';
import type { TFunction } from 'i18next';

import { authenticatedFetch } from '../../../utils/api';

type OidcStatus = { configured: boolean; localAccess: boolean; loginUrl: string };
type OidcSession = { email: string; name: string };

type SidebarAccountButtonProps = {
  onShowSettings: () => void;
  t: TFunction;
};

/**
 * The account state at a glance: signed in, signed out with a sign-in
 * available, or local access with no sign-in configured. It sits beside the
 * archive control because that row is the sidebar's status line.
 *
 * Signing out stays in Settings: a one-click logout in the footer is a trap
 * next to a button people press all day.
 */
export default function SidebarAccountButton({ onShowSettings, t }: SidebarAccountButtonProps) {
  const [status, setStatus] = useState<OidcStatus | null>(null);
  const [session, setSession] = useState<OidcSession | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const statusResponse = await authenticatedFetch('/api/auth/oidc/status');
        const statusBody = await statusResponse.json() as { data?: OidcStatus };
        const sessionResponse = await authenticatedFetch('/api/auth/oidc/session');
        const sessionBody = sessionResponse.ok
          ? await sessionResponse.json() as { data?: OidcSession }
          : null;
        if (disposed) return;
        setStatus(statusBody.data ?? null);
        setSession(sessionBody?.data ?? null);
      } catch {
        // Auth cannot be asked (an older server, an offline shell): the footer
        // shows no account control rather than a state it made up.
      }
    })();
    return () => { disposed = true; };
  }, []);

  if (!status) return null;

  if (session) {
    const label = t('account.signedInAs', { email: session.email, defaultValue: 'Signed in as {{email}}' });
    return (
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-lg text-primary outline-hidden transition-colors hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onShowSettings}
        aria-label={label}
        title={label}
      >
        <CircleUser className="size-4" aria-hidden />
      </button>
    );
  }

  if (status.configured) {
    const label = t('account.signIn', 'Sign in');
    return (
      <a
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        href={status.loginUrl || '/api/auth/oidc/start'}
        aria-label={label}
        title={label}
      >
        <LogIn className="size-4" aria-hidden />
      </a>
    );
  }

  const localLabel = t('account.localAccess', 'Local access');
  return (
    <span
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/70"
      aria-label={localLabel}
      title={localLabel}
    >
      <ShieldCheck className="size-4" aria-hidden />
    </span>
  );
}
