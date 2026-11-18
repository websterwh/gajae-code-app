import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * A saved PAT is only useful if the things that run in this container can see
 * it: agents inherit this process's environment, `git` needs a credential,
 * `gh` needs its own login, and an SSH shell needs the variables too. The token
 * is written to the mounted config volume, never into the image.
 *
 * Scope note: `repo` is the narrowest GitHub scope that can read a private
 * repository *and* push to it. A read-only scope could not make commits, which
 * is half of what the token is for.
 */
export const GITHUB_TOKEN_VARIABLES = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

const GITHUB_TOKEN_PATTERN = /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/u;
const GITHUB_HOST = 'github.com';

export function isGithubToken(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_TOKEN_PATTERN.test(value.trim());
}

export function maskGithubToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 10) return '••••';
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}

/** `git` reads this file for `credential.helper=store`. */
export function githubCredentialLine(token: string): string {
  return `https://x-access-token:${token.trim()}@${GITHUB_HOST}`;
}

/** Where an SSH shell learns the token. Mounted, so it survives a recreate. */
export function githubShellEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GJC_GITHUB_ENV_FILE) return path.resolve(env.GJC_GITHUB_ENV_FILE);
  if (existsSync('/data/shell')) return '/data/shell/github.env';
  return path.join(env.GJC_WORKER_AGENT_DIR ? path.dirname(env.GJC_WORKER_AGENT_DIR) : path.join(homedir(), '.gjc'), 'github.env');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], env: options.env ?? process.env });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
    if (options.input) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

type ApplyOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string }) => Promise<void>;
};

/**
 * Idempotent: saving twice leaves one credential line, not two, and booting
 * re-applies the stored token so an agent started after a restart still has it.
 */
export async function applyGithubToken(token: string, options: ApplyOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const value = token.trim();
  for (const variable of GITHUB_TOKEN_VARIABLES) env[variable] = value;

  const home = options.home ?? env.GJC_GITHUB_HOME ?? homedir();
  const credentialsPath = path.join(home, '.git-credentials');
  const existing = await readFile(credentialsPath, 'utf8').catch(() => '');
  const kept = existing.split(/\r?\n/u).filter((line) => line.trim() !== '' && !line.includes(`@${GITHUB_HOST}`));
  await mkdir(home, { recursive: true });
  await writeFile(credentialsPath, `${[...kept, githubCredentialLine(value)].join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(credentialsPath, 0o600);

  const shellEnv = githubShellEnvPath(env);
  await mkdir(path.dirname(shellEnv), { recursive: true });
  await writeFile(shellEnv, [
    '# Written by gajae-code when a GitHub token is saved.',
    '# Sourced by ~/.bashrc so SSH sessions and terminals have the token too.',
    `export GITHUB_TOKEN=${shellQuote(value)}`,
    `export GH_TOKEN=${shellQuote(value)}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  await chmod(shellEnv, 0o600);

  const exec = options.run ?? run;
  await exec('git', ['config', '--global', 'credential.helper', 'store'], { env });
  // Best effort: gh is optional, and a failure here must not lose the token.
  await exec('gh', ['auth', 'login', '--with-token'], { env, input: value });
}

/**
 * Booting re-applies the saved token: a container restart starts a new process
 * with an empty environment, and the agents it spawns would otherwise have no
 * token until someone opened Settings again.
 */
export async function restoreSavedGithubToken(): Promise<boolean> {
  // Relative, not `@/`: tsc-alias rewrites static imports, not dynamic ones.
  const { githubTokensDb } = await import('../database/index.js');
  const token = githubTokensDb.getAnyActiveGithubToken();
  if (!token) return false;
  await applyGithubToken(token);
  return true;
}

export async function clearGithubToken(options: ApplyOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  for (const variable of GITHUB_TOKEN_VARIABLES) delete env[variable];

  const home = options.home ?? env.GJC_GITHUB_HOME ?? homedir();
  const credentialsPath = path.join(home, '.git-credentials');
  const existing = await readFile(credentialsPath, 'utf8').catch(() => '');
  const kept = existing.split(/\r?\n/u).filter((line) => line.trim() !== '' && !line.includes(`@${GITHUB_HOST}`));
  if (kept.length === 0) await rm(credentialsPath, { force: true });
  else await writeFile(credentialsPath, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });

  await rm(githubShellEnvPath(env), { force: true });

  const exec = options.run ?? run;
  await exec('gh', ['auth', 'logout', '--hostname', GITHUB_HOST], { env });
}
