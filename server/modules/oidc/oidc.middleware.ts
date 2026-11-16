import type { NextFunction, Request, Response } from 'express';

import { isDesktopMode } from '@/middleware/desktop-auth.js';
import { isPrivateAddress, stripMappedV4 } from '@/shared/peer-address.js';

import { hostControlAvailable } from '../host-control/index.js';

import { oidcEnforcing, readOidcConfig } from './oidc.config.js';
import { readSession } from './oidc.sessions.js';

/**
 * Paths that keep working without a browser sign-in. Every entry is a surface
 * that authenticates itself, or that has to be reachable before a sign-in (the
 * login flow and the assets its page needs).
 *
 * `/api/automation` and `/api/browser` are deliberately absent: they dispatch
 * commands into a paired companion and drive CDP, so they are protected like
 * every other router. Their device-credential path is admitted by the gate's
 * `authenticateRequest` hook, not by an exemption.
 *
 * `/ws` is exempt from the cookie gate only because the upgrade handshake
 * checks a session or deployment key itself; HTTP middleware does not run on
 * an upgrade. Anything added here must be authenticated by other means.
 */
export const OIDC_EXEMPT_PREFIXES = [
  '/health',
  // Sign-in itself: status, discovery, start, callback, sign-out, config.
  '/api/auth',
  // The GJC worker/jobs surface authenticates with its own API key.
  '/api/gjc',
  // Desktop updater relay is validated against the desktop key.
  '/api/desktop',
  // Chat and terminal sockets run their own handshake authentication.
  '/ws',
  '/.well-known',
] as const;

/**
 * Paths the local-access bypass never covers on its own. A trusted LAN address
 * is a convenience for reading the app, not a grant of control over the Docker
 * daemon, so host control needs either a session or the deployment's own
 * opt-in (see `coversLocalBypass`).
 */
export const SESSION_ONLY_PREFIXES = ['/api/host'] as const;

export function requiresSession(pathname: string): boolean {
  return SESSION_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Whether the local-access bypass reaches a path.
 *
 * Host control is the one surface it does not reach by default, because a LAN
 * address is not a statement about the Docker daemon. `GAJAE_HOST_CONTROL` is:
 * the operator puts it in the container's environment beside the socket mount,
 * and no request can set it. Requiring a sign-in on top of it was a dead end
 * for the LAN topology the bypass exists for - the operator who opted in still
 * could not reach their own switch - so the opt-in stands in for the session.
 * Without the variable every `/api/host` route is inert anyway, and with it the
 * capabilities stay off until they are switched on in Settings.
 */
export function coversLocalBypass(pathname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !requiresSession(pathname) || hostControlAvailable(env);
}

const STATIC_FILE = /\.[a-z0-9]{1,8}$/iu;

export function isExemptPath(pathname: string): boolean {
  if (OIDC_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
  // Hashed bundles, icons and the manifest are needed to render the login page.
  return STATIC_FILE.test(pathname);
}

/** `true`/`false` are canonical; `1`/`0` stay accepted for older deployments. */
function envFlag(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/**
 * The deliberate break-glass switch: NO_AUTH=true (or GAJAE_NO_AUTH=true) turns
 * the gate off without touching the stored settings, so a broken provider
 * cannot lock the operator out. The retired GAJAE_ALLOW_UNAUTH_REMOTE bind flag
 * is never read here: images shipped it as 1, which would have switched sign-in
 * off for every deployment that never asked for that.
 */
export function noAuthEnabled(): boolean {
  return envFlag(process.env.NO_AUTH) || envFlag(process.env.GAJAE_NO_AUTH);
}

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

function toV6(address: string): bigint | null {
  const value = stripMappedV4(String(address ?? '').trim()).toLowerCase();
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const parts = [...head, ...Array<string>(missing).fill('0'), ...tail];
  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return null;
    result = (result << 16n) | BigInt(parseInt(part, 16));
  }
  return result;
}

function matchesEntry(address: string, entry: string): boolean {
  const rule = entry.trim();
  if (!rule) return false;
  const [network, prefix] = rule.split('/');
  const base = stripMappedV4(network ?? '');
  const addressV6 = toV6(address);
  const networkV6 = toV6(network ?? '');
  if (prefix === undefined) {
    if (addressV6 !== null && networkV6 !== null) return addressV6 === networkV6;
    return stripMappedV4(address) === base;
  }

  const bits = Number(prefix);
  if (addressV6 !== null && networkV6 !== null) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    if (bits === 0) return true;
    const shift = BigInt(128 - bits);
    return (networkV6 >> shift) === (addressV6 >> shift);
  }

  const networkValue = toV4(base);
  const addressValue = toV4(stripMappedV4(address));
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
 * The address to judge. `x-forwarded-for` is believed only when the peer that
 * sent it is itself local - a reverse proxy on the host or the container
 * network. Anywhere else the header is a value the client typed, and `trust
 * proxy` would happily adopt it: a direct request to the published port could
 * claim `192.168.1.50` and be treated as a LAN client. Everything that makes an
 * access decision goes through here so the gate and the settings guard cannot
 * drift apart.
 */
export function clientAddress(request: {
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
  ip?: string;
}): string {
  const socket = stripMappedV4(String(request.socket?.remoteAddress ?? '').trim());
  if (request.headers['x-forwarded-for'] !== undefined && isPrivateAddress(socket)) {
    return stripMappedV4(String(request.ip ?? socket).trim());
  }
  return socket;
}

/**
 * Sign-in gate. Inert unless an issuer, client id and secret are all present, and
 * never applied to the desktop shell, which authenticates per boot with its own
 * key. Addresses on the local-access list skip it, and every request that
 * arrives through a connection the app opened for itself (the worker socket, the
 * companion relay) authenticates on its own.
 */
export type OidcGateOptions = {
  /**
   * A request that authenticates itself outside the cookie (a paired device
   * credential on the automation and browser surfaces). It runs after the
   * session check, so a signed-in caller never depends on it.
   */
  authenticateRequest?: (request: Request) => boolean;
};

/**
 * `trust proxy` never ran on an upgrade request, so Express never stamped `ip`.
 * The nearest proxy is the last hop it appended to `x-forwarded-for`.
 */
function forwardedClientAddress(request: {
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
}): string | undefined {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : undefined;
}

/**
 * Whether a request reaches the app without a session: the desktop shell, sign-in
 * that is not enforcing, the NO_AUTH break-glass, or a trusted local address.
 *
 * The WebSocket upgrade runs no HTTP middleware, so the handshake asks this
 * instead of restating the gate. Restating it is how a LAN deployment ended up
 * with a fully working app and a 401 on every `/ws` handshake: HTTP admitted the
 * local address, while the handshake only ever looked for a cookie.
 */
export function admitsWithoutSession(request: {
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
  url?: string;
}): boolean {
  const config = readOidcConfig();
  if (isDesktopMode() || !oidcEnforcing(config) || noAuthEnabled()) return true;
  if (!config.allowLocal) return false;
  const target = String(request.url ?? '/');
  const pathname = target.startsWith('/') ? target.split('?')[0] || '/' : '/';
  if (!coversLocalBypass(pathname)) return false;
  const ip = forwardedClientAddress(request);
  const address = clientAddress({ socket: request.socket, headers: request.headers, ...(ip ? { ip } : {}) });
  return clientAddressAllowed(address, config.allowedIps);
}

export function createOidcGate(options: OidcGateOptions = {}) {
  return (request: Request, response: Response, next: NextFunction) => {
    const config = readOidcConfig();
    if (isDesktopMode() || !oidcEnforcing(config) || isExemptPath(request.path)) return next();
    if (noAuthEnabled()) return next();

    if (config.allowLocal && coversLocalBypass(request.path) && clientAddressAllowed(clientAddress(request), config.allowedIps)) return next();

    const session = readSession(request.headers.cookie);
    if (session) return next();
    if (options.authenticateRequest?.(request)) return next();

    const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');
    if (acceptsHtml && request.method === 'GET') {
      const target = encodeURIComponent(request.originalUrl);
      return response.redirect(302, `/api/auth/oidc/start?returnTo=${target}`);
    }
    return response.status(401).json({ success: false, error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in to continue.' } });
  };
}
