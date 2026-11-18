import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Per-package install state.
 *
 * The old boot marker was an md5 of the whole env var, written whether or not
 * the install worked: a failed package was recorded as installed and never
 * retried. This ledger has one entry per package, written only after the
 * install and its verification both succeed. It is additive - an absent or
 * unreadable file means "nothing installed", never "remove things".
 */
export type InstallManager = 'uv' | 'pip' | 'npm' | 'aqua' | 'apt';
export const INSTALL_MANAGERS: readonly InstallManager[] = ['uv', 'pip', 'npm', 'aqua', 'apt'];

export type LedgerStatus = 'installed' | 'failed';
export type LedgerAttempt = { status: LedgerStatus; at: string; error?: string };
export type LedgerEntry = {
  spec: string;
  version: string | null;
  status: LedgerStatus;
  installedAt?: string;
  pin?: string | null;
  lastAttempt?: LedgerAttempt;
  error?: string;
};
export type Ledger = {
  version: 1;
  packages: Record<InstallManager, Record<string, LedgerEntry>>;
};

const EMPTY_PACKAGES = (): Record<InstallManager, Record<string, LedgerEntry>> => ({
  uv: {}, pip: {}, npm: {}, aqua: {}, apt: {},
});

export function emptyLedger(): Ledger {
  return { version: 1, packages: EMPTY_PACKAGES() };
}

/** Under the config mount (beside the agent dir), so it survives with the user's config. */
export function ledgerFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GJC_PROVISION_LEDGER) return path.resolve(env.GJC_PROVISION_LEDGER);
  const agentDir = env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
  return path.join(path.dirname(agentDir), 'app', 'provision-ledger.json');
}

function isEntry(value: unknown): value is LedgerEntry {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as LedgerEntry).spec === 'string'
    && ((value as LedgerEntry).status === 'installed' || (value as LedgerEntry).status === 'failed');
}

export async function readLedger(file: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Ledger>;
    const ledger = emptyLedger();
    for (const manager of INSTALL_MANAGERS) {
      const bucket = parsed.packages?.[manager];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [name, entry] of Object.entries(bucket)) {
        if (isEntry(entry)) ledger.packages[manager][name] = entry;
      }
    }
    return ledger;
  } catch {
    // Missing, unreadable or malformed: nothing is installed as far as this
    // boot is concerned, and the next success rewrites the file.
    return emptyLedger();
  }
}

export async function writeLedger(file: string, ledger: Ledger): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function recordInstalled(
  ledger: Ledger,
  manager: InstallManager,
  name: string,
  entry: { spec: string; version: string | null; pin?: string | null; at?: string },
): LedgerEntry {
  const next: LedgerEntry = {
    spec: entry.spec,
    version: entry.version,
    status: 'installed',
    installedAt: entry.at ?? new Date().toISOString(),
    ...(entry.pin ? { pin: entry.pin } : {}),
  };
  ledger.packages[manager][name] = next;
  return next;
}

/**
 * A failure is recorded without erasing a previous good install: the entry
 * keeps `status: installed` and its version, and the failed attempt appears in
 * `lastAttempt`. With no good entry yet, the entry itself is failed, so the
 * next boot retries it (a failed entry is never skipped as installed).
 */
export function recordFailure(
  ledger: Ledger,
  manager: InstallManager,
  name: string,
  spec: string,
  error: string,
  at = new Date().toISOString(),
): LedgerEntry {
  const previous = ledger.packages[manager][name];
  const attempt: LedgerAttempt = { status: 'failed', at, error };
  if (previous && previous.status === 'installed') {
    previous.lastAttempt = attempt;
    previous.spec = spec;
    previous.error = error;
    return previous;
  }
  const next: LedgerEntry = { spec, version: null, status: 'failed', error, lastAttempt: attempt };
  ledger.packages[manager][name] = next;
  return next;
}

/** Every entry that is not usable, for `GET /api/mcp/status`. */
export function failedEntries(ledger: Ledger): Array<{ manager: InstallManager; name: string; entry: LedgerEntry }> {
  const failed: Array<{ manager: InstallManager; name: string; entry: LedgerEntry }> = [];
  for (const manager of INSTALL_MANAGERS) {
    for (const [name, entry] of Object.entries(ledger.packages[manager])) {
      if (entry.status === 'failed' || entry.lastAttempt?.status === 'failed') {
        failed.push({ manager, name, entry });
      }
    }
  }
  return failed;
}
