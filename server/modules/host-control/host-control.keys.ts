import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseSshPrivateKey } from '../../gjc-engine.js';

const run = promisify(execFile);

export type GeneratedSshKeyPair = { privateKey: string; publicKey: string };

/**
 * A fresh Ed25519 key for the app to authenticate with.
 *
 * The key is written only inside a private temporary directory and removed from
 * disk immediately; the caller stores the private half in the encrypted
 * secret store and may show the public half once. Anyone with the private key
 * can log in as the SSH user, so it is never returned by the API.
 */
export async function generateSshKeyPair(): Promise<GeneratedSshKeyPair> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gajae-host-control-'));
  try {
    const keyPath = path.join(directory, 'id_ed25519');
    try {
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gajae-host-control', '-f', keyPath], {
        timeout: 15_000,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT'
        ? 'ssh-keygen is not installed on this server.'
        : 'ssh-keygen could not create a key pair.');
    }
    const privateKey = parseSshPrivateKey(await readFile(keyPath, 'utf8'));
    if (!privateKey) throw new Error('ssh-keygen produced a key this app cannot use.');
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
    if (!publicKey) throw new Error('ssh-keygen produced no public key.');
    return { privateKey, publicKey };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The destination's host key, read the only way it can be read: from the
 * destination. A host key generated here would belong to this process and
 * could never match the machine being reached.
 */
export async function scanSshHostKey(host: string, port: number): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run('ssh-keyscan', [
      '-T', '10',
      '-p', String(port),
      '-t', 'ed25519',
      host,
    ], { timeout: 15_000, maxBuffer: 64 * 1024 }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT'
      ? 'ssh-keyscan is not installed on this server.'
      : 'The host did not answer with a host key.');
  }
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^\S+ ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(entry));
  if (!line) throw new Error('The host did not answer with a host key.');
  const [, algorithm, key] = line.split(/\s+/u);
  return `${algorithm} ${key}`;
}
