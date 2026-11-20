import { useEffect, useRef, useState } from 'react';
import { CircleUser, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import type { TFunction } from 'i18next';

import { authenticatedFetch } from '../../../utils/api';

type OidcStatus = { configured: boolean; localAccess: boolean; loginUrl: string };
type OidcSession = { email: string; name: string };

type SidebarAccountButtonProps = {
  t: TFunction;
};

/**
 * The account state at a glance: signed in, signed out with a sign-in
 * available, or local access with no sign-in configured. It sits beside the
 * archive control because that row is the sidebar's status line.
 *
 * Signed in, the button opens a small popover naming the account and offering
 * the sign-out action itself; sending someone to Settings to find it buried the
 * one thing the button is for.
 */
export default function SidebarAccountButton({ t }: SidebarAccountButtonProps) {
  const [status, setStatus] = useState<OidcStatus | null>(null);
  const [session, setSession] = useState<OidcSession | null>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!open) return undefined;
    const closeForPointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeForPointer);
    document.addEventListener('keydown', closeForEscape);
    return () => {
      document.removeEventListener('mousedown', closeForPointer);
      document.removeEventListener('keydown', closeForEscape);
    };
  }, [open]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    try {
      const response = await authenticatedFetch('/api/auth/oidc/logout', { method: 'POST' });
      if (!response.ok) throw new Error(`Sign-out refused: ${response.status}`);
      const body = await response.json().catch(() => null) as {
        data?: { logoutUrl?: string | null };
      } | null;
      const logoutUrl = body?.data?.logoutUrl;
      if (logoutUrl) {
        // Follow the provider's logout endpoint: its SSO session survives our
        // cookie, and the next reload would otherwise sign us back in. It
        // returns the browser here once that session is gone.
        window.location.assign(logoutUrl);
        return;
      }
      // A full reload drops every cached read made under the old session; there
      // is no client-side auth store to clear instead.
      window.location.reload();
    } catch {
      setSignOutError(t('account.signOutFailed', 'Could not sign out. Try again.'));
      setSigningOut(false);
    }
  };

  if (!status) return null;

  if (session) {
    const label = t('account.signedInAs', { email: session.email, defaultValue: 'Signed in as {{email}}' });
    const displayName = session.name?.trim() || session.email;
    return (
      <div ref={containerRef} className="relative">
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-primary outline-hidden transition-colors hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          title={label}
        >
          <CircleUser className="size-4" aria-hidden />
        </button>
        {open && (
          <div
            role="menu"
            className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <div className="px-2.5 py-1.5">
              <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
              {session.name?.trim() ? (
                <p className="truncate text-xs text-muted-foreground">{session.email}</p>
              ) : null}
            </div>
            <div className="mx-1 my-1 h-px bg-border" />
            {signOutError && (
              <p role="alert" className="px-2.5 pb-1 text-xs text-destructive">{signOutError}</p>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={signingOut}
              onClick={() => { void signOut(); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LogOut className="size-4" aria-hidden />
              {signingOut ? t('account.signingOut', 'Signing out…') : t('account.signOut', 'Sign out')}
            </button>
          </div>
        )}
      </div>
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
