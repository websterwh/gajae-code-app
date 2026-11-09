import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { appConfigDb } from '@/modules/database/index.js';

const SECRET_KEY = 'oidc.session.secret.v1';

export const SESSION_COOKIE = 'gajae_oidc_session';
export const TRANSACTION_COOKIE = 'gajae_oidc_tx';

export type OidcSession = {
  sub: string;
  email: string;
  name?: string;
  /** Epoch milliseconds. */
  exp: number;
};

export type OidcTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** Where the browser lands after a successful sign-in. */
  returnTo: string;
  exp: number;
};

function signingSecret(): string {
  const stored = appConfigDb.get(SECRET_KEY);
  if (stored) return stored;
  const minted = randomBytes(32).toString('base64url');
  appConfigDb.set(SECRET_KEY, minted);
  return minted;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function sign(payload: string): string {
  return createHmac('sha256', signingSecret()).update(payload).digest('base64url');
}

function compare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function seal<T extends object>(value: T): string {
  const payload = encode(value);
  return `${payload}.${sign(payload)}`;
}

export function open<T extends object>(token: string | undefined | null): T | null {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!compare(signature, sign(payload))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof value.exp !== 'number' || value.exp <= Date.now()) return null;
    return value as T;
  } catch {
    return null;
  }
}

export function readSession(cookieHeader: string | undefined): OidcSession | null {
  return open<OidcSession>(cookieValue(cookieHeader, SESSION_COOKIE));
}

export function readTransaction(cookieHeader: string | undefined): OidcTransaction | null {
  return open<OidcTransaction>(cookieValue(cookieHeader, TRANSACTION_COOKIE));
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

/** `Secure` only when the request arrived over TLS, so plain-http self-hosting works. */
export function cookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function serializeCookie(name: string, value: string, attributes: string): string {
  return `${name}=${encodeURIComponent(value)}; ${attributes}`;
}

export function clearedCookie(name: string, secure: boolean): string {
  return `${name}=; ${cookieAttributes(secure, 0)}`;
}
