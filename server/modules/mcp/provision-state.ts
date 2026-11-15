import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { InstallManager } from './ledger.js';

/**
 * Cross-process progress for boot provisioning.
 *
 * The entrypoint starts provisioning in a background subshell, so the server
 * process cannot see the child's memory. A small file under the config mount
 * is the honest shared channel: `/api/mcp/status` reports "in flight, package
 * X" while it is true instead of guessing from an empty ledger.
 */
export type ProvisionState = {
  running: boolean;
  /** Who wrote it, so a state left behind by a dead writer is not believed. */
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  current?: { manager: InstallManager; package: string };
  completed: number;
  failed: number;
  managers?: Partial<Record<InstallManager, { startedAt?: string; finishedAt?: string }>>;
};

export function provisionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GJC_PROVISION_STATE) return path.resolve(env.GJC_PROVISION_STATE);
  const agentDir = env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
  return path.join(path.dirname(agentDir), 'app', 'provision-state.json');
}

export async function readProvisionState(file: string): Promise<ProvisionState | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ProvisionState;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      running: parsed.running === true,
      pid: Number.isFinite(parsed.pid) ? Number(parsed.pid) : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
      finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      current: parsed.current,
      completed: Number.isFinite(parsed.completed) ? Number(parsed.completed) : 0,
      failed: Number.isFinite(parsed.failed) ? Number(parsed.failed) : 0,
      managers: parsed.managers,
    };
  } catch {
    return null;
  }
}

/** How long a running state may go without a heartbeat before it is stale. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * A container restart during boot provisioning leaves `running: true` behind,
 * and nothing else ever clears it: the page then spins until the next rebuild.
 * The writer's pid and its last heartbeat are what separate real work from that
 * leftover.
 */
export function provisionStateIsLive(state: ProvisionState | null, now = Date.now()): boolean {
  if (!state?.running) return false;
  const seen = Date.parse(state.updatedAt ?? state.startedAt ?? '');
  if (!Number.isFinite(seen) || now - seen > STALE_AFTER_MS) return false;
  // Writers from before the pid was recorded can only be judged by heartbeat.
  if (state.pid === undefined) return true;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function writeProvisionState(file: string, state: ProvisionState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
