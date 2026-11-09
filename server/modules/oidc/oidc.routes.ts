import express, { type Request, type Response } from 'express';

import { getConnection } from '@/modules/database/index.js';
import { asyncHandler } from '@/shared/utils.js';

import {
  OIDC_REDIRECT_PATH,
  oidcEnforcing,
  publicOidcConfig,
  readOidcConfig,
  validateOidcConfig,
  writeOidcConfig,
  type OidcConfig,
} from './oidc.config.js';
import { createOidcGate } from './oidc.middleware.js';
import {
  buildAuthorizeUrl,
  completeSignIn,
  createTransaction,
  discoverOidc,
  identityAllowed,
} from './oidc.provider.js';
import {
  SESSION_COOKIE,
  TRANSACTION_COOKIE,
  clearedCookie,
  cookieAttributes,
  readSession,
  readTransaction,
  seal,
  serializeCookie,
} from './oidc.sessions.js';

const SESSION_TTL_SECONDS = 12 * 60 * 60;

const ok = (response: Response, data: unknown) => response.json({ success: true, data });
const fail = (response: Response, status: number, code: string, message: string) => response
  .status(status)
  .json({ success: false, error: { code, message } });

const text = (value: unknown, limit = 512): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry, 320)).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function redirectUriFor(request: Request, config: OidcConfig): string {
  if (config.redirectUri) return config.redirectUri;
  return `${request.protocol}://${request.get('host') ?? 'localhost'}${OIDC_REDIRECT_PATH}`;
}

/** Local owner row for a provider identity; the username is the verified email. */
function ensureOwner(identity: { email: string; name?: string }): { id: number; username: string } {
  const db = getConnection();
  const existing = db.prepare('SELECT id, username FROM users WHERE username = ? LIMIT 1')
    .get(identity.email) as { id: number; username: string } | undefined;
  if (existing) return existing;
  const created = db.prepare('INSERT INTO users (username, password_hash, git_name) VALUES (?, ?, ?)')
    .run(identity.email, 'oidc:no-password', identity.name ?? null);
  return { id: Number(created.lastInsertRowid), username: identity.email };
}

/**
 * Settings may be read or written before a sign-in only while enforcement is
 * off; once it is on, only a signed-in owner may change it.
 */
function requireOwnerWhenEnforced(request: Request, response: Response): boolean {
  if (!oidcEnforcing(readOidcConfig())) return true;
  if (readSession(request.headers.cookie)) return true;
  fail(response, 401, 'SIGN_IN_REQUIRED', 'Sign in to change authentication settings.');
  return false;
}

export function createOidcRouter() {
  const router = express.Router();

  router.get('/status', (_request, response) => {
    const config = readOidcConfig();
    ok(response, {
      enabled: config.enabled,
      configured: oidcEnforcing(config),
      issuer: config.issuer,
      localAccess: config.allowLocal,
      loginUrl: '/api/auth/oidc/start',
    });
  });

  router.get('/config', (request, response) => {
    if (!requireOwnerWhenEnforced(request, response)) return;
    ok(response, publicOidcConfig(readOidcConfig()));
  });

  router.put('/config', (request, response) => {
    if (!requireOwnerWhenEnforced(request, response)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const next = writeOidcConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      issuer: body.issuer === undefined ? undefined : text(body.issuer, 512),
      clientId: body.clientId === undefined ? undefined : text(body.clientId, 512),
      // An empty string means "keep the stored secret", which the client cannot read.
      clientSecret: typeof body.clientSecret === 'string' && body.clientSecret ? body.clientSecret : undefined,
      scopes: body.scopes === undefined ? undefined : text(body.scopes, 256),
      redirectUri: body.redirectUri === undefined ? undefined : text(body.redirectUri, 512),
      allowedDomains: body.allowedDomains === undefined ? undefined : stringList(body.allowedDomains),
      allowedEmails: body.allowedEmails === undefined ? undefined : stringList(body.allowedEmails),
      allowedGroups: body.allowedGroups === undefined ? undefined : stringList(body.allowedGroups),
      allowLocal: typeof body.allowLocal === 'boolean' ? body.allowLocal : undefined,
      allowedIps: body.allowedIps === undefined ? undefined : stringList(body.allowedIps),
    });
    const problem = validateOidcConfig(next);
    if (problem) return fail(response, 400, 'OIDC_CONFIG_INVALID', problem);
    ok(response, publicOidcConfig(next));
  });

  /** Auto discovery, surfaced to the settings tab before anything is saved. */
  router.post('/discover', asyncHandler(async (request, response) => {
    if (!requireOwnerWhenEnforced(request, response)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const issuer = text(body.issuer, 512) || readOidcConfig().issuer;
    if (!issuer) return fail(response, 400, 'OIDC_ISSUER_REQUIRED', 'Enter an issuer URL first.');
    try {
      const discovery = await discoverOidc(issuer, true);
      return ok(response, discovery);
    } catch (error) {
      return fail(response, 400, 'OIDC_DISCOVERY_FAILED', error instanceof Error ? error.message : 'Discovery failed.');
    }
  }));

  router.get('/start', asyncHandler(async (request, response) => {
    const config = readOidcConfig();
    if (!oidcEnforcing(config)) return fail(response, 404, 'OIDC_DISABLED', 'OIDC sign-in is not configured.');
    const discovery = await discoverOidc(config.issuer);
    const redirectUri = redirectUriFor(request, config);
    const transaction = createTransaction(redirectUri);
    const returnTo = text(request.query.returnTo, 2048) || '/';

    response.setHeader('set-cookie', serializeCookie(
      TRANSACTION_COOKIE,
      seal({ ...transaction, returnTo }),
      cookieAttributes(request.secure, 600),
    ));
    return response.redirect(302, buildAuthorizeUrl(config, discovery, transaction, redirectUri));
  }));

  router.get('/callback', asyncHandler(async (request, response) => {
    const config = readOidcConfig();
    if (!oidcEnforcing(config)) return fail(response, 404, 'OIDC_DISABLED', 'OIDC sign-in is not configured.');
    const transaction = readTransaction(request.headers.cookie);
    if (!transaction) return fail(response, 400, 'OIDC_STATE_INVALID', 'This sign-in attempt expired. Start again.');
    const error = text(request.query.error, 256);
    if (error) return fail(response, 401, 'OIDC_PROVIDER_ERROR', text(request.query.error_description, 512) || error);
    const state = text(request.query.state, 256);
    const code = text(request.query.code, 4096);
    if (!state || state !== transaction.state) return fail(response, 400, 'OIDC_STATE_INVALID', 'The sign-in state did not match.');
    if (!code) return fail(response, 400, 'OIDC_CODE_MISSING', 'The provider returned no authorization code.');

    const discovery = await discoverOidc(config.issuer);
    const identity = await completeSignIn(config, discovery, {
      code,
      redirectUri: transaction.redirectUri,
      codeVerifier: transaction.codeVerifier,
      nonce: transaction.nonce,
    });
    if (!identityAllowed(config, identity)) {
      return fail(response, 403, 'OIDC_IDENTITY_NOT_ALLOWED', `Sign-in is not allowed for ${identity.email}.`);
    }

    const owner = ensureOwner(identity);
    const session = seal({
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    });
    response.setHeader('set-cookie', [
      serializeCookie(SESSION_COOKIE, session, cookieAttributes(request.secure, SESSION_TTL_SECONDS)),
      clearedCookie(TRANSACTION_COOKIE, request.secure),
    ]);
    // Only a same-app path is acceptable: a sealed cookie must never become an
    // open redirect into another origin.
    const destination = transaction.returnTo.startsWith('/') && !transaction.returnTo.startsWith('//')
      ? transaction.returnTo
      : '/';
    return response.redirect(302, destination);
  }));

  router.post('/logout', (request, response) => {
    response.setHeader('set-cookie', clearedCookie(SESSION_COOKIE, request.secure));
    ok(response, { signedOut: true });
  });

  /** Who the current cookie belongs to, for the settings tab and the shell. */
  router.get('/session', (request, response) => {
    const session = readSession(request.headers.cookie);
    if (!session) return fail(response, 401, 'SIGN_IN_REQUIRED', 'No sign-in session.');
    return ok(response, { email: session.email, name: session.name ?? '', sub: session.sub, expiresAt: session.exp });
  });

  return router;
}

export { createOidcGate };
