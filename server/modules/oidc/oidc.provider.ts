import { constants, createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';

import type { OidcConfig } from './oidc.config.js';
import { normalizeIssuer } from './oidc.config.js';

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
};

export type OidcIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  /** Provider group names; empty when the `groups` scope was not granted. */
  groups: string[];
};

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();

type JsonObject = Record<string, unknown>;

async function getJson(url: string, init?: RequestInit): Promise<JsonObject> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    // A refused token exchange is only diagnosable through the provider's own
    // body (`invalid_grant`, `invalid_client`, a PKCE mismatch, ...), so it is
    // carried into the message the settings page shows.
    const detail = (await response.text().catch(() => '')).trim().slice(0, 400);
    throw new Error(`${url} answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return await response.json() as JsonObject;
}

/**
 * Auto discovery: everything after the issuer comes from the provider's own
 * `/.well-known/openid-configuration`, so no endpoint is hardcoded per vendor.
 */
export async function discoverOidc(issuer: string, refresh = false): Promise<OidcDiscovery> {
  const base = normalizeIssuer(issuer);
  const cached = discoveryCache.get(base);
  if (!refresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;

  const url = `${base}/.well-known/openid-configuration`;
  const document = await getJson(url);
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
  for (const field of required) {
    if (typeof document[field] !== 'string' || !document[field]) {
      throw new Error(`Discovery document is missing ${field}.`);
    }
  }
  // The issuer must round-trip: otherwise the id_token `iss` check would compare
  // against a value the provider never emits.
  if (normalizeIssuer(String(document.issuer)) !== base) {
    throw new Error(`Discovery issuer ${String(document.issuer)} does not match ${base}.`);
  }

  const value: OidcDiscovery = {
    issuer: normalizeIssuer(String(document.issuer)),
    authorization_endpoint: String(document.authorization_endpoint),
    token_endpoint: String(document.token_endpoint),
    jwks_uri: String(document.jwks_uri),
    userinfo_endpoint: typeof document.userinfo_endpoint === 'string' ? document.userinfo_endpoint : undefined,
    end_session_endpoint: typeof document.end_session_endpoint === 'string' ? document.end_session_endpoint : undefined,
    scopes_supported: Array.isArray(document.scopes_supported)
      ? document.scopes_supported.map((scope) => String(scope))
      : undefined,
    token_endpoint_auth_methods_supported: Array.isArray(document.token_endpoint_auth_methods_supported)
      ? document.token_endpoint_auth_methods_supported.map((method) => String(method))
      : undefined,
  };
  discoveryCache.set(base, { at: Date.now(), value });
  return value;
}

export function createTransaction(redirectUri: string, ttlMs = 10 * 60 * 1000) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return {
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    codeVerifier,
    codeChallenge,
    redirectUri,
    exp: Date.now() + ttlMs,
  };
}

export function buildAuthorizeUrl(
  config: OidcConfig,
  discovery: OidcDiscovery,
  transaction: { state: string; nonce: string; codeChallenge: string },
  redirectUri: string,
): string {
  const scopes = new Set(config.scopes.split(/\s+/u).filter(Boolean));
  scopes.add('openid');
  // Without this scope the provider omits the claim the group gate reads.
  if (config.allowedGroups.length) scopes.add('groups');
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', [...scopes].join(' '));
  url.searchParams.set('state', transaction.state);
  url.searchParams.set('nonce', transaction.nonce);
  url.searchParams.set('code_challenge', transaction.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeCode(
  config: OidcConfig,
  discovery: OidcDiscovery,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ idToken: string; accessToken?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // Providers disagree about client authentication: Kanidm takes HTTP Basic
  // only, Pocket ID and Keycloak accept the secret in the body. Discovery says
  // which, and the body form is the fallback when it says nothing.
  const methods = discovery.token_endpoint_auth_methods_supported ?? [];
  if (methods.includes('client_secret_basic') && !methods.includes('client_secret_post')) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${credentials}`;
  } else {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }
  const document = await getJson(discovery.token_endpoint, { method: 'POST', headers, body });
  const idToken = document.id_token;
  if (typeof idToken !== 'string' || !idToken) throw new Error('The token response carried no id_token.');
  return {
    idToken,
    accessToken: typeof document.access_token === 'string' ? document.access_token : undefined,
  };
}

async function signingKeys(jwksUri: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const document = await getJson(jwksUri);
  const keys = Array.isArray(document.keys) ? document.keys as JsonWebKey[] : [];
  if (!keys.length) throw new Error('The provider published no signing keys.');
  jwksCache.set(jwksUri, { at: Date.now(), keys });
  return keys;
}

const DIGESTS: Record<string, string | null> = {
  RS256: 'sha256', RS384: 'sha384', RS512: 'sha512',
  PS256: 'sha256', PS384: 'sha384', PS512: 'sha512',
  ES256: 'sha256', ES384: 'sha384', ES512: 'sha512',
};

const decodeSegment = (segment: string): JsonObject => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as JsonObject;

/**
 * Signature first, then claims: an unsigned token is never trusted even when its
 * payload happens to look right.
 */
async function verifyIdToken(
  config: OidcConfig,
  discovery: OidcDiscovery,
  idToken: string,
  nonce: string,
): Promise<JsonObject> {
  const [headerSegment, payloadSegment, signatureSegment] = idToken.split('.');
  if (!headerSegment || !payloadSegment || !signatureSegment) throw new Error('The id_token is malformed.');
  const header = decodeSegment(headerSegment);
  const algorithm = String(header.alg ?? '');
  const digest = DIGESTS[algorithm];
  if (!digest) throw new Error(`Unsupported id_token algorithm ${algorithm}.`);

  const keys = await signingKeys(discovery.jwks_uri);
  const key = header.kid ? keys.find((candidate) => candidate.kid === header.kid) : keys[0];
  if (!key) throw new Error('No signing key matches the id_token.');

  const publicKey = createPublicKey({ key, format: 'jwk' });
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'utf8');
  const signature = Buffer.from(signatureSegment, 'base64url');
  // ES* signatures are raw r||s rather than DER, and PS* needs the PSS padding
  // constant; both are per-algorithm, so the key object carries them.
  const verificationKey = algorithm.startsWith('ES')
    ? { key: publicKey, dsaEncoding: 'ieee-p1363' as const }
    : algorithm.startsWith('PS')
      ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
      : { key: publicKey };
  if (!verifySignature(digest, signed, verificationKey, signature)) {
    throw new Error('The id_token signature is invalid.');
  }

  const claims = decodeSegment(payloadSegment);
  if (normalizeIssuer(String(claims.iss ?? '')) !== discovery.issuer) throw new Error('The id_token issuer is not the configured issuer.');
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? '')];
  if (!audiences.includes(config.clientId)) throw new Error('The id_token audience is not this client.');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('The id_token has expired.');
  if (claims.nonce !== nonce) throw new Error('The id_token nonce does not match this sign-in.');
  return claims;
}

/**
 * The identity the app will sign in: `sub` is required, `email` decides the
 * allow-list and becomes the local owner's username.
 */
export async function completeSignIn(
  config: OidcConfig,
  discovery: OidcDiscovery,
  input: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
): Promise<OidcIdentity> {
  const { idToken } = await exchangeCode(config, discovery, input.code, input.redirectUri, input.codeVerifier);
  const claims = await verifyIdToken(config, discovery, idToken, input.nonce);
  const sub = String(claims.sub ?? '');
  if (!sub) throw new Error('The id_token carries no subject.');
  const email = String(claims.email ?? claims.preferred_username ?? '').trim();
  if (!email) throw new Error('The id_token carries no email; request the email scope.');
  const rawGroups = claims.groups;
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map((group) => String(group).trim()).filter(Boolean)
    : typeof rawGroups === 'string' ? rawGroups.split(/[\s,]+/u).filter(Boolean) : [];
  return {
    sub,
    email: email.toLowerCase(),
    emailVerified: claims.email_verified !== false,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    groups,
  };
}

export function identityAllowed(config: OidcConfig, identity: OidcIdentity): boolean {
  if (!identity.emailVerified) return false;
  const email = identity.email.toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  // Every configured gate has to pass: an email list and a group list together
  // mean "this person, in this group", not "either"
  if (config.allowedEmails.length && !config.allowedEmails.includes(email)) return false;
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) return false;
  if (config.allowedGroups.length) {
    const owned = new Set(identity.groups.map((group) => group.toLowerCase()));
    if (!config.allowedGroups.some((group) => owned.has(group.toLowerCase()))) return false;
  }
  return true;
}
