import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { appConfigDb, getDatabasePath } from '@/modules/database/index.js';

/**
 * The SSH private key, encrypted at rest.
 *
 * The key reaches root on the machine it can log into, so it does not sit in
 * plain text beside the settings that describe it. `host.control.v1` stays
 * readable JSON; the key lives under its own row as AES-256-GCM ciphertext, and
 * the master key is either `GAJAE_HOST_CONTROL_KEY` (a deployment-managed
 * secret, the better choice) or a 32-byte file with mode 0600 written next to
 * the database on first use.
 *
 * Nothing here ever returns the key to a caller other than the run policy that
 * has to hand it to the worker, and no route serializes it back to a browser.
 */
const KEY_CONFIG = 'host.control.sshkey.v1';
const KEY_FILE = 'host-control.key';
const VERSION = 'v1';

function hashConfiguredSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function configuredMasterKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const configured = String(env.GAJAE_HOST_CONTROL_KEY ?? '').trim();
  if (configured.length === 0) return undefined;
  if (/^[0-9a-f]{64}$/iu.test(configured)) return Buffer.from(configured, 'hex');
  const base64 = Buffer.from(configured, 'base64');
  if (base64.length === 32 && base64.toString('base64').replace(/=+$/u, '') === configured.replace(/=+$/u, '')) {
    return base64;
  }
  // Any other operator-chosen passphrase is still a secret; derive a key from it
  // rather than refusing to start the feature.
  return hashConfiguredSecret(configured);
}

function readKeyFile(file: string): Buffer | undefined {
  try {
    const key = readFileSync(file);
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = configuredMasterKey(env);
  if (configured) return configured;
  const directory = dirname(getDatabasePath());
  const file = join(directory, KEY_FILE);
  const existing = readKeyFile(file);
  if (existing) return existing;
  mkdirSync(directory, { recursive: true });
  const generated = randomBytes(32);
  try {
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return generated;
  } catch {
    // Another process won the race; its key is the one the ciphertext will use.
    const raced = readKeyFile(file);
    if (raced) return raced;
    throw new Error('The host-control key file could not be written.');
  }
}

export function encryptSshPrivateKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSshPrivateKey(stored: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const [version, iv, tag, ciphertext] = stored.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(env), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // A key file that was replaced or a row that was edited: treat it as absent
    // rather than starting a run with a key that cannot authenticate.
    return undefined;
  }
}

export function writeSshPrivateKey(key: string, env: NodeJS.ProcessEnv = process.env): void {
  appConfigDb.set(KEY_CONFIG, encryptSshPrivateKey(key, env));
}

export function clearSshPrivateKey(): void {
  // The store has no delete; an empty row is the same absence to every reader
  // here, and a stored ciphertext always starts with the version prefix.
  appConfigDb.set(KEY_CONFIG, '');
}

export function readSshPrivateKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stored = appConfigDb.get(KEY_CONFIG);
  if (!stored) return undefined;
  return decryptSshPrivateKey(stored, env);
}

export function sshPrivateKeyPresent(): boolean {
  return Boolean(appConfigDb.get(KEY_CONFIG));
}
