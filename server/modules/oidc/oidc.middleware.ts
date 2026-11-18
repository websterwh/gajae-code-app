import type { NextFunction, Request, Response } from 'express';

import { isDesktopMode } from '@/middleware/desktop-auth.js';
import { isLoopbackAddress, isPrivateAddress, stripMappedV4 } from '@/shared/peer-address.js';

import { oidcEnforcing, readOidcConfig, type OidcConfig } from './oidc.config.js';
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
 * The app's own build output and public directory. This is a positive list,
 * not "any path ending in an extension": project files and chat images carry
 * real extensions too, and a suffix test let `/api/assets/images/<id>.png` past
 * the gate without a session.
 */
const STATIC_PREFIX = /^\/(?:assets|brand|icons|screenshots)\//u;
const STATIC_ROOT_FILE = /^\/(?:favicon\.png|mark\.svg|manifest\.json|sw\.js)$/u;

export function isExemptPath(pathname: string): boolean {
  if (OIDC_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
  // Hashed bundles, icons and the manifest are needed to render the login page.
  return STATIC_PREFIX.test(pathname) || STATIC_ROOT_FILE.test(pathname);
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
 * Addresses whose `x-forwarded-for` is believed. Loopback is the proxy on this
 * host. Any other peer has to be named in `TRUSTED_PROXIES`, because "on a
 * private network" describes the client as often as it describes the proxy: a
 * LAN client that reaches the port directly can write any header it likes, and
 * treating that header as its address let it claim a loopback or allow-listed
 * value and skip the sign-in challenge.
 */
export function trustedProxyEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  // `TRUSTED_PROXIES` is the name to document. The prefixed spelling is what
  // the variable shipped as, so an existing deployment keeps working without
  // an edit, and a deployment that sets both gets the unprefixed one.
  const configured = env.TRUSTED_PROXIES ?? env.GAJAE_TRUSTED_PROXIES ?? '';
  return configured.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
}

export function isTrustedProxy(address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = stripMappedV4(String(address ?? '').trim());
  if (!value) return false;
  if (isLoopbackAddress(value)) return true;
  return trustedProxyEntries(env).some((entry) => matchesEntry(value, entry));
}

/**
 * The address to judge. Everything that makes an access decision goes through
 * here, so the gate, the settings guard and the automation middleware cannot
 * disagree about who a request is.
 */
export function clientAddress(request: {
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
  ip?: string;
}): string {
  const socket = stripMappedV4(String(request.socket?.remoteAddress ?? '').trim());
  if (request.headers['x-forwarded-for'] !== undefined && isTrustedProxy(socket)) {
    return stripMappedV4(String(request.ip ?? socket).trim());
  }
  return socket;
}

/**
 * Whether the local-access toggle alone admits a request. The settings guard
 * uses exactly this rule rather than a wider one: with the toggle off, sharing
 * a network with the app is not a grant, so changing authentication settings
 * needs a session.
 */
export function localAccessAdmits(
  request: { socket?: { remoteAddress?: string }; headers: Record<string, unknown>; ip?: string },
  config: Pick<OidcConfig, 'allowLocal' | 'allowedIps'>,
): boolean {
  return Boolean(config.allowLocal && clientAddressAllowed(clientAddress(request), config.allowedIps));
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
 * There is no path carve-out: the local-access toggle is the one grant that
 * covers the whole surface, and every route keeps its own permission checks on
 * top of it (host control is inert without `GAJAE_HOST_CONTROL`, and its
 * capabilities stay off until they are switched on in Settings).
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
  const ip = forwardedClientAddress(request);
  const address = clientAddress({ socket: request.socket, headers: request.headers, ...(ip ? { ip } : {}) });
  return clientAddressAllowed(address, config.allowedIps);
}

export function createOidcGate(options: OidcGateOptions = {}) {
  return (request: Request, response: Response, next: NextFunction) => {
    const config = readOidcConfig();
    if (isDesktopMode() || !oidcEnforcing(config) || isExemptPath(request.path)) return next();
    if (noAuthEnabled()) return next();

    if (localAccessAdmits(request, config)) return next();

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
