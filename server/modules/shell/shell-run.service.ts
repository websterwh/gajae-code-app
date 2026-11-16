import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { childEnvironment } from '@/shared/child-environment.js';

/**
 * One command, one answer.
 *
 * The app already has a live PTY for interactive work (`/ws/shell`); `/run` is
 * for "just show me what `adb connect` prints", so it runs the command once,
 * waits for it, and hands back everything it wrote. The server is already the
 * owner's machine — the same shell is reachable over the PTY socket — so this
 * adds no capability the app did not have; it only makes one call reachable as
 * a plain request that a chat message can render.
 */

export type ShellRunResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

export class ShellRunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellRunRequestError';
  }
}

export const SHELL_RUN_MIN_TIMEOUT_MS = 1_000;
export const SHELL_RUN_DEFAULT_TIMEOUT_MS = 30_000;
export const SHELL_RUN_MAX_TIMEOUT_MS = 120_000;
export const SHELL_RUN_MAX_COMMAND_BYTES = 32 * 1024;
/** Enough for a build log's tail; far more than a chat message should carry. */
export const SHELL_RUN_MAX_OUTPUT_CHARS = 60_000;

const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu;

export function parseShellRunRequest(body: unknown): { command: string; cwd: string; timeoutMs: number } {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const command = typeof record.command === 'string' ? record.command.trim() : '';
  if (!command) throw new ShellRunRequestError('A shell command is required.');
  if (command.includes('\u0000')) throw new ShellRunRequestError('A shell command cannot contain a NUL byte.');
  if (Buffer.byteLength(command, 'utf8') > SHELL_RUN_MAX_COMMAND_BYTES) {
    throw new ShellRunRequestError(`A shell command is limited to ${SHELL_RUN_MAX_COMMAND_BYTES} bytes.`);
  }

  // Like a terminal opened from the CLI, any existing directory is a valid
  // place to run; only a path that is not one is refused.
  const requested = typeof record.cwd === 'string' && record.cwd ? path.resolve(record.cwd) : process.cwd();
  let directory = false;
  try {
    directory = fs.statSync(requested).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) throw new ShellRunRequestError(`Not a directory: ${requested}`);

  const asked = typeof record.timeoutMs === 'number' && Number.isSafeInteger(record.timeoutMs)
    ? record.timeoutMs
    : SHELL_RUN_DEFAULT_TIMEOUT_MS;
  return {
    command,
    cwd: requested,
    timeoutMs: Math.min(Math.max(asked, SHELL_RUN_MIN_TIMEOUT_MS), SHELL_RUN_MAX_TIMEOUT_MS),
  };
}

export function runShellCommand(body: unknown): Promise<ShellRunResult> {
  const { command, cwd, timeoutMs } = parseShellRunRequest(body);
  const startedAt = Date.now();
  const windows = process.platform === 'win32';

  return new Promise((resolve) => {
    const child = spawn(
      windows ? 'powershell.exe' : 'bash',
      windows ? ['-NoLogo', '-NoProfile', '-Command', command] : ['-lc', command],
      {
        cwd,
        // The server's own API credentials are not part of the user's shell.
        env: { ...childEnvironment(), TERM: 'dumb', NO_COLOR: '1' },
        // A group lets a timeout take the whole tree, not just the shell.
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    let truncated = false;
    let timedOut = false;

    const collect = (chunk: Buffer) => {
      if (output.length >= SHELL_RUN_MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      const room = SHELL_RUN_MAX_OUTPUT_CHARS - output.length;
      output += text.slice(0, room);
      if (text.length > room) truncated = true;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        if (windows) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* it already exited */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const finish = (result: Omit<ShellRunResult, 'command' | 'cwd' | 'output' | 'truncated' | 'timedOut' | 'durationMs'>) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        output: output.replace(ANSI_SEQUENCE, ''),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    child.on('error', (error) => {
      output = `${output}${output ? '\n' : ''}${error.message}`;
      finish({ exitCode: null, signal: null });
    });
    child.on('close', (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
  });
}
