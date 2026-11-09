import { appConfigDb } from '@/modules/database/index.js';

/**
 * How the owner signs in when OIDC is enabled. Stored as one JSON value so a
 * half-written configuration can never be read field by field.
 */
export type OidcConfig = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space separated, `openid` always added on use. */
  scopes: string;
  /** Empty means "derive from the incoming request" (proxy-friendly). */
  redirectUri: string;
  /** Optional email gates; empty means any identity the provider asserts. */
  allowedDomains: string[];
  allowedEmails: string[];
};

const CONFIG_KEY = 'oidc.config.v1';

const EMPTY_CONFIG: OidcConfig = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  redirectUri: '',
  allowedDomains: [],
  allowedEmails: [],
};

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map((entry) => String(entry).trim().toLowerCase())
  .filter(Boolean);

/** Trailing slashes make `iss` comparisons fail against a provider's own value. */
export function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function readOidcConfig(): OidcConfig {
  const raw = appConfigDb.get(CONFIG_KEY);
  if (!raw) return { ...EMPTY_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<OidcConfig>;
    return {
      enabled: parsed.enabled === true,
      issuer: normalizeIssuer(String(parsed.issuer ?? '')),
      clientId: String(parsed.clientId ?? '').trim(),
      clientSecret: String(parsed.clientSecret ?? ''),
      scopes: String(parsed.scopes ?? EMPTY_CONFIG.scopes).trim() || EMPTY_CONFIG.scopes,
      redirectUri: String(parsed.redirectUri ?? '').trim(),
      allowedDomains: listOf(parsed.allowedDomains),
      allowedEmails: listOf(parsed.allowedEmails),
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function writeOidcConfig(patch: Partial<OidcConfig>): OidcConfig {
  const current = readOidcConfig();
  const next: OidcConfig = {
    enabled: patch.enabled ?? current.enabled,
    issuer: patch.issuer === undefined ? current.issuer : normalizeIssuer(patch.issuer),
    clientId: patch.clientId === undefined ? current.clientId : String(patch.clientId).trim(),
    // The client never receives the secret, so an absent field means "keep it".
    clientSecret: patch.clientSecret === undefined || patch.clientSecret === null
      ? current.clientSecret
      : String(patch.clientSecret),
    scopes: patch.scopes === undefined ? current.scopes : (String(patch.scopes).trim() || EMPTY_CONFIG.scopes),
    redirectUri: patch.redirectUri === undefined ? current.redirectUri : String(patch.redirectUri).trim(),
    allowedDomains: patch.allowedDomains === undefined ? current.allowedDomains : listOf(patch.allowedDomains),
    allowedEmails: patch.allowedEmails === undefined ? current.allowedEmails : listOf(patch.allowedEmails),
  };
  appConfigDb.set(CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** What the settings tab may see: everything except the secret itself. */
export function publicOidcConfig(config: OidcConfig) {
  return {
    enabled: config.enabled,
    issuer: config.issuer,
    clientId: config.clientId,
    hasClientSecret: Boolean(config.clientSecret),
    scopes: config.scopes,
    redirectUri: config.redirectUri,
    allowedDomains: config.allowedDomains,
    allowedEmails: config.allowedEmails,
  };
}

/**
 * Enforcement needs all three parts. An enabled-but-incomplete config stays
 * inert on purpose: a typo must never lock the owner out of their own app.
 */
export function oidcEnforcing(config: OidcConfig): boolean {
  return config.enabled && Boolean(config.issuer) && Boolean(config.clientId) && Boolean(config.clientSecret);
}

export function validateOidcConfig(config: OidcConfig): string | null {
  if (!config.enabled) return null;
  if (!config.issuer) return 'An issuer URL is required.';
  let parsed: URL;
  try {
    parsed = new URL(config.issuer);
  } catch {
    return 'The issuer must be an absolute URL.';
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !local) return 'The issuer must use https.';
  if (!config.clientId) return 'A client id is required.';
  if (!config.clientSecret) return 'A client secret is required.';
  return null;
}

export const OIDC_REDIRECT_PATH = '/api/auth/oidc/callback';
