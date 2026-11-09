import type { NextFunction, Request, Response } from 'express';

import { isDesktopMode } from '@/middleware/desktop-auth.js';

import { oidcEnforcing, readOidcConfig } from './oidc.config.js';
import { readSession } from './oidc.sessions.js';

/**
 * Paths that keep working without a browser sign-in. Every entry here is a
 * surface that authenticates itself, or that has to be reachable before a
 * sign-in (the login flow and the assets its page needs).
 */
export const OIDC_EXEMPT_PREFIXES = [
  '/health',
  // Sign-in itself: status, discovery, start, callback, sign-out, config.
  '/api/auth',
  // The GJC worker/jobs surface authenticates with its own API key.
  '/api/gjc',
  // Remote CUA companion, browser and CDP automation carry their own tokens.
  '/api/automation',
  '/api/browser',
  // Desktop updater relay is validated against the desktop key.
  '/api/desktop',
  // Chat and terminal sockets run their own handshake authentication.
  '/ws',
  '/.well-known',
] as const;

const STATIC_FILE = /\.[a-z0-9]{1,8}$/iu;

export function isExemptPath(pathname: string): boolean {
  if (OIDC_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
  // Hashed bundles, icons and the manifest are needed to render the login page.
  return STATIC_FILE.test(pathname);
}

/**
 * Sign-in gate. Inert unless an issuer, client id and secret are all present, and
 * never applied to the desktop shell, which authenticates per boot with its own
 * key.
 */
export function createOidcGate() {
  return (request: Request, response: Response, next: NextFunction) => {
    const config = readOidcConfig();
    if (isDesktopMode() || !oidcEnforcing(config) || isExemptPath(request.path)) return next();

    const session = readSession(request.headers.cookie);
    if (session) return next();

    const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');
    if (acceptsHtml && request.method === 'GET') {
      const target = encodeURIComponent(request.originalUrl);
      return response.redirect(302, `/api/auth/oidc/start?returnTo=${target}`);
    }
    return response.status(401).json({ success: false, error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in to continue.' } });
  };
}
