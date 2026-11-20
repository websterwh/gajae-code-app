import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isRemoteTarget,
  type SshHostTarget,
} from './gjc-host-control-policy.js';

/**
 * SSH, but the same narrow surface as the socket path.
 *
 * There is no command string here either: a caller names a verb, and the verb
 * is one fixed command from the table below. What SSH adds is a machine the
 * container has no Docker socket for - host-level facts, init services, and
 * (behind a per-call approval) a restart of one named service or container.
 *
 * Two properties are not negotiable:
 *
 * - The server host key is pinned. Key authentication against an unpinned host
 *   is one `known_hosts` write away from a machine-in-the-middle, and this key
 *   reaches root on that box. `StrictHostKeyChecking=yes` plus a one-line
 *   `known_hosts` holding exactly the pinned key, and nothing else.
 * - The private key exists only as a 0600 file inside a 0700 directory that is
 *   removed after the call. It is never passed on a command line (`-i` takes a
 *   path) and never written next to the app's data.
 */

export type SshVerb = {
  id: string;
  summary: string;
  mutating: boolean;
  /** One fixed command. The only caller influence is the validated target. */
  command: string | ((target: string) => string);
  target?: 'container' | 'service';
};

/**
 * Read verbs run without a prompt. That is safe *because* this table is the
 * whole vocabulary: no caller can ask for a path, an environment or a log, so
 * nothing here can read a secret the operator did not already choose to expose.
 */
export const SSH_READ_VERBS: readonly SshVerb[] = [
  { id: 'host.info', summary: 'Kernel, distro and uptime', mutating: false, command: 'uname -a; cat /etc/os-release; uptime' },
  { id: 'host.disk', summary: 'Filesystem usage', mutating: false, command: 'df -hP -x tmpfs -x devtmpfs' },
  { id: 'host.storage', summary: 'Block devices, RAID and pools', mutating: false, command: 'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RO 2>/dev/null; cat /proc/mdstat 2>/dev/null; command -v zpool >/dev/null 2>&1 && zpool list' },
  // /proc instead of `free`: procps is not guaranteed on a small host.
  { id: 'host.memory', summary: 'Memory, swap and load', mutating: false, command: 'cat /proc/meminfo /proc/swaps /proc/loadavg' },
  { id: 'host.network', summary: 'Interface addresses', mutating: false, command: 'ip -br addr' },
  { id: 'host.listeners', summary: 'Listening TCP/UDP sockets', mutating: false, command: 'ss -lntu' },
  { id: 'service.status', summary: 'Status of one service', mutating: false, target: 'service', command: (target) => `service ${target} status` },
  { id: 'docker.ps', summary: 'Running containers', mutating: false, command: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'" },
  { id: 'docker.images', summary: 'Images on the host', mutating: false, command: "docker images --format 'table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}'" },
  { id: 'docker.inspect', summary: 'State of one container', mutating: false, target: 'container', command: (target) => `docker inspect --format '{{json .State}}' ${target}` },
];

/** Writes. Each one asks first unless the operator pre-authorized host writes. */
export const SSH_WRITE_VERBS: readonly SshVerb[] = [
  { id: 'service.restart', summary: 'Restart one service', mutating: true, target: 'service', command: (target) => `service ${target} restart` },
  { id: 'docker.restart', summary: 'Restart one container', mutating: true, target: 'container', command: (target) => `docker restart ${target}` },
];

export const SSH_VERBS: readonly SshVerb[] = [...SSH_READ_VERBS, ...SSH_WRITE_VERBS];

export function findSshVerb(id: unknown): SshVerb | undefined {
  if (typeof id !== 'string') return undefined;
  return SSH_VERBS.find((verb) => verb.id === id);
}

export function describeSshVerbs(): Array<{ id: string; summary: string; mutating: boolean; target: string | null }> {
  return SSH_VERBS.map((verb) => ({
    id: verb.id,
    summary: verb.summary,
    mutating: verb.mutating,
    target: verb.target ?? null,
  }));
}

/** The remote command a verb resolves to, after target validation. */
export function resolveSshCommand(verb: SshVerb, target?: string): string {
  if (verb.target) {
    if (!target) throw new Error(`TARGET_REQUIRED: ${verb.id} needs a ${verb.target} name.`);
    if (!isRemoteTarget(target)) {
      throw new Error(`INVALID_TARGET: ${JSON.stringify(target)} is not a plain ${verb.target} name.`);
    }
  } else if (target !== undefined) {
    throw new Error(`${verb.id} takes no target.`);
  }
  return typeof verb.command === 'function' ? verb.command(target!) : verb.command;
}

/**
 * The single `known_hosts` line this call trusts. A non-default port is part of
 * the key's identity in that format - `[host]:port` - and leaving the brackets
 * off would silently pin the key for the wrong address.
 */
export function knownHostsLine(target: Pick<SshHostTarget, 'host' | 'port' | 'hostKey'>): string {
  const host = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
  return `${host} ${target.hostKey}\n`;
}

/**
 * The argument list, exported so the pinning can be asserted without a daemon.
 * `-F /dev/null` keeps a user `ssh_config` (ProxyCommand, a second identity)
 * out of the call; `BatchMode` makes an unanswerable prompt a failure instead
 * of a hung turn.
 */
export function sshArguments(target: SshHostTarget, command: string, paths: { key: string; knownHosts: string }): string[] {
  const remote = `sh -c ${shellQuote(command)}`;
  return [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${paths.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR',
    '-i', paths.key,
    '-p', String(target.port),
    '-l', target.user,
    target.host,
    remote,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export type SshExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export type SshRunOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Test seam; production always uses the image's `ssh`. */
  binary?: string;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Runs one verb on the pinned host. The key file and the `known_hosts` file are
 * created for this call only and removed in `finally`, including on timeout,
 * abort or a spawn failure.
 */
export async function runSshCommand(
  target: SshHostTarget,
  command: string,
  options: SshRunOptions = {},
): Promise<SshExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const binary = options.binary ?? process.env.GAJAE_SSH_BINARY ?? 'ssh';
  const directory = await mkdtemp(join(tmpdir(), `gajae-ssh-${randomBytes(4).toString('hex')}-`));
  const keyPath = join(directory, 'id');
  const knownHostsPath = join(directory, 'known_hosts');
  try {
    await chmod(directory, 0o700);
    await writeFile(keyPath, `${target.privateKey}\n`, { mode: 0o600 });
    await writeFile(knownHostsPath, knownHostsLine(target), { mode: 0o600 });
    return await spawnSsh(binary, sshArguments(target, command, { key: keyPath, knownHosts: knownHostsPath }), {
      timeoutMs,
      maxBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnSsh(
  binary: string,
  args: string[],
  { timeoutMs, maxBytes, signal }: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = maxBytes - size[stream];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      chunks[stream].push(kept);
      size[stream] += kept.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const finish = (result: SshExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const kill = () => {
      if (!child.killed) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      kill();
      finish({
        exitCode: 130,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: 'aborted',
        truncated,
        timedOut: false,
      });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', fail);
    child.on('close', (code) => {
      finish({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: timedOut
          ? `timed out after ${timeoutMs} ms`
          : Buffer.concat(chunks.stderr).toString('utf8'),
        truncated,
        timedOut,
      });
    });
  });
}
