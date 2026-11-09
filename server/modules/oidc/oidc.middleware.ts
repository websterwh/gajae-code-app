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
 * The deliberate break-glass switch: NO_AUTH (or GAJAE_NO_AUTH) turns the gate
 * off without touching the stored settings, so a broken provider cannot lock the
 * operator out. GAJAE_ALLOW_UNAUTH_REMOTE is deliberately not consulted here -
 * container images ship it as 1 for the bind guard, which would have switched
 * sign-in off for every deployment that never asked for that.
 */
export function noAuthEnabled(): boolean {
  return process.env.NO_AUTH === '1' || process.env.GAJAE_NO_AUTH === '1';
}

const stripMappedV4 = (address: string): string => address.replace(/^::ffff:/iu, '');

const isLoopback = (address: string): boolean => address === '::1'
  || address === 'localhost'
  || address.startsWith('127.');

/** RFC1918 plus unique-local IPv6: "the machine next to this one". */
const isPrivateAddress = (address: string): boolean => isLoopback(address)
  || address.startsWith('10.')
  || address.startsWith('192.168.')
  || /^172\.(1[6-9]|2\d|3[01])\./u.test(address)
  || /^f[cd][0-9a-f]{2}:/iu.test(address);

function toV4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || part === '') return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function matchesEntry(address: string, entry: string): boolean {
  const rule = entry.trim();
  if (!rule) return false;
  const [network, prefix] = rule.split('/');
  const base = stripMappedV4(network ?? '');
  if (prefix === undefined) return stripMappedV4(address) === base;

  const networkValue = toV4(base);
  const addressValue = toV4(stripMappedV4(address));
  const bits = Number(prefix);
  if (networkValue === null || addressValue === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (networkValue & mask) === (addressValue & mask);
}

/**
 * The local-access allow-list. With no entries it means loopback and private
 * ranges, so the toggle alone is enough for a LAN-only deployment.
 */
export function clientAddressAllowed(address: string, entries: string[]): boolean {
  const value = stripMappedV4(String(address ?? '').trim());
  if (!value) return false;
  if (!entries.length) return isPrivateAddress(value);
  return entries.some((entry) => matchesEntry(value, entry));
}

/**
 * Sign-in gate. Inert unless an issuer, client id and secret are all present, and
 * never applied to the desktop shell, which authenticates per boot with its own
 * key. Addresses on the local-access list skip it, and every request that
 * arrives through a connection the app opened for itself (the worker socket, the
 * companion relay) authenticates on its own.
 */
export function createOidcGate() {
  return (request: Request, response: Response, next: NextFunction) => {
    const config = readOidcConfig();
    if (isDesktopMode() || !oidcEnforcing(config) || isExemptPath(request.path)) return next();
    if (noAuthEnabled()) return next();

    if (config.allowLocal) {
      const address = request.ip ?? request.socket.remoteAddress ?? '';
      if (clientAddressAllowed(address, config.allowedIps)) return next();
    }

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
