import { spawn } from 'node:child_process';

import { recordFailure, recordInstalled, type InstallManager, type Ledger, type LedgerEntry } from './ledger.js';
import { normalizePin, parsePackageSpec, pinnedSpec } from './pins.js';

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export type ProvisionOutcome = {
  manager: InstallManager;
  name: string;
  spec: string;
  status: 'installed' | 'failed';
  version: string | null;
  error?: string;
  /** `verified` means the pre-install check found a healthy install, so no install ran. */
  action?: 'verified' | 'installed';
};

export type ProvisionProgress = { manager: InstallManager; package: string; command: string };

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The last few stderr lines are the part a boot log can actually use. */
export function tailLines(text: string, count = 5): string {
  const lines = String(text ?? '').trim().split(/\r?\n/u).filter(Boolean);
  return lines.slice(-count).join(' | ');
}

export function installCommand(
  manager: InstallManager,
  parsed: ReturnType<typeof parsePackageSpec>,
  pin: string | null | undefined,
): { command: string; args: string[] } {
  const spec = pinnedSpec(parsed, pin, manager);
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'install', '-q', spec] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'install', '-q', '--system', spec] };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', '--no-fund', '--no-audit', spec] };
    case 'aqua':
      return { command: 'install-github-app', args: [spec] };
  }
}

/** `skylot/jadx` installs a `jadx` binary; a generic aqua package writes /data/aqua/aqua.yaml. */
function aquaBinary(name: string): string {
  const last = name.split('/').filter(Boolean).pop() ?? name;
  return last.replace(/\.git$/u, '').toLowerCase();
}

/**
 * `aqua list` needs an aqua.yaml, which only the generic fallback writes, so
 * the installer's special handlers (jadx, apktool) failed verification with
 * "configuration file isn't found" after a perfectly good install. Check the
 * binary the installer linked into PATH first, then the aqua config.
 */
const AQUA_VERIFY = [
  'bin=$(command -v "$1" 2>/dev/null) && { printf "%s\\n" "$bin"; exit 0; }',
  'cfg="${AQUA_ROOT_DIR:-/data/aqua}/aqua.yaml"',
  '[ -f "$cfg" ] && aqua list -c "$cfg" 2>/dev/null | grep -F -- "$2"',
].join('; ');

/** The one process runner both boot provisioning and the HTTP API use. */
export function spawnCommandRunner(): CommandRunner {
  return (command, args, options) => new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function verifyCommand(manager: InstallManager, name: string): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'list'] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'show', name] };
    case 'npm':
      return { command: 'npm', args: ['ls', '-g', '--json', '--depth=0', name] };
    case 'aqua':
      return { command: 'sh', args: ['-c', AQUA_VERIFY, 'sh', aquaBinary(name), name] };
  }
}

/** Exit 0 alone is not proof: `uv tool list` succeeds on an empty tool set. */
function verificationConfirms(manager: InstallManager, name: string, output: string, version: string | null): boolean {
  if (manager === 'uv') return version !== null || output.includes(name);
  // The aqua check is the command itself: exit 0 means the binary or the
  // package entry was found, and it prints what it found.
  if (manager === 'aqua') return output.trim().length > 0;
  return version !== null;
}

export function parseInstalledVersion(manager: InstallManager, name: string, output: string): string | null {
  switch (manager) {
    case 'uv': {
      const match = new RegExp(`^\\s*${escapeRegExp(name)}\\s+v?(\\S+)\\s*$`, 'mu').exec(output);
      return match?.[1] ?? null;
    }
    case 'pip': {
      const match = /^Version:\s*(\S+)\s*$/mu.exec(output);
      return match?.[1] ?? null;
    }
    case 'npm': {
      try {
        const parsed = JSON.parse(output) as { dependencies?: Record<string, { version?: string }> };
        return parsed.dependencies?.[name]?.version ?? null;
      } catch {
        return null;
      }
    }
    case 'aqua':
      return null;
  }
}

/**
 * Install each package, verify it, and write the ledger only on success.
 *
 * A failed install is logged with its command, exit code and the tail of the
 * error, recorded as failed, and skipped so the remaining packages still get
 * their turn. A failed entry is never mistaken for an installed one, so the
 * next boot retries it.
 */
export async function provisionPackages(options: {
  manager: InstallManager;
  packages: string[];
  ledger: Ledger;
  runner: CommandRunner;
  pins?: Record<string, string | null>;
  log?: (line: string) => void;
  onProgress?: (progress: ProvisionProgress) => void | Promise<void>;
  now?: () => string;
}): Promise<ProvisionOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const outcomes: ProvisionOutcome[] = [];

  for (const raw of options.packages) {
    const parsed = parsePackageSpec(raw);
    if (!parsed.name) continue;
    const pin = normalizePin(options.pins?.[parsed.name]);
    const spec = pinnedSpec(parsed, pin, options.manager);
    // Verify first: a healthy install is left alone, so a reboot costs one
    // local command per package instead of a networked install. A pin the
    // installed version does not satisfy is not healthy.
    const preflight = verifyCommand(options.manager, parsed.name);
    const preflightResult = await options.runner(preflight.command, preflight.args);
    const preflightVersion = preflightResult.code === 0
      ? parseInstalledVersion(options.manager, parsed.name, preflightResult.stdout)
      : null;
    const preflightHealthy = preflightResult.code === 0
      && verificationConfirms(options.manager, parsed.name, preflightResult.stdout, preflightVersion)
      && (!pin || preflightVersion === null || preflightVersion === pin);
    if (preflightHealthy) {
      const version = preflightVersion ?? pin ?? parsed.version;
      recordInstalled(options.ledger, options.manager, parsed.name, { spec, version, pin, at: now() });
      log(`[${options.manager}] ${parsed.name}${version ? ` ${version}` : ''} is present; verified.`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'installed', version, action: 'verified' });
      continue;
    }

    const install = installCommand(options.manager, parsed, pin);
    const printable = [install.command, ...install.args].join(' ');
    await options.onProgress?.({ manager: options.manager, package: parsed.name, command: printable });

    const result = await options.runner(install.command, install.args);
    if (result.code !== 0) {
      const error = `exit ${result.code}: ${tailLines(result.stderr || result.stdout)}`;
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed (${error}) - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }

    const verify = verifyCommand(options.manager, parsed.name);
    const verified = await options.runner(verify.command, verify.args);
    if (verified.code !== 0) {
      const error = `install exited 0 but verification failed (exit ${verified.code}): ${tailLines(verified.stderr || verified.stdout)}`;
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed verification - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }

    // `latest` is resolved here, at install time, and the concrete version is
    // what the ledger (and the UI) records as actually running.
    const detected = parseInstalledVersion(options.manager, parsed.name, verified.stdout);
    if (!verificationConfirms(options.manager, parsed.name, verified.stdout, detected)) {
      const error = 'install exited 0 but the package is not present in the tool inventory';
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed verification - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }
    const version = detected ?? pin ?? parsed.version;
    recordInstalled(options.ledger, options.manager, parsed.name, { spec, version, pin, at: now() });
    log(`[${options.manager}] ${parsed.name}${version ? ` ${version}` : ''} installed.`);
    outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'installed', version, action: 'installed' });
  }

  return outcomes;
}

/** One package, one upgrade attempt. A pinned entry is never passed here. */
export async function upgradePackage(options: {
  manager: InstallManager;
  name: string;
  entry: LedgerEntry;
  ledger: Ledger;
  runner: CommandRunner;
  log?: (line: string) => void;
  now?: () => string;
}): Promise<ProvisionOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const { manager, name, entry, ledger, runner } = options;
  const parsed = parsePackageSpec(entry.spec);
  const upgrade = upgradeCommand(manager, parsed);
  const result = await runner(upgrade.command, upgrade.args);
  if (result.code !== 0) {
    const detail = tailLines(result.stderr || result.stdout);
    // `uv tool upgrade` refuses a tool that is missing from the inventory and
    // tells you to install it. Installing is the recovery; retrying the
    // upgrade every boot is what left the entry failed forever.
    if (manager === 'uv' && /not installed/iu.test(detail)) {
      log(`[uv] ${name} is missing from the tool inventory; installing it again.`);
      const reinstall = installCommand(manager, parsed, null);
      const retried = await runner(reinstall.command, reinstall.args);
      if (retried.code !== 0) {
        const error = `reinstall exit ${retried.code}: ${tailLines(retried.stderr || retried.stdout)}`;
        recordFailure(ledger, manager, name, entry.spec, error, now());
        log(`[uv] ${name} reinstall failed (exit ${retried.code}).`);
        return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
      }
    } else {
      const error = `update exit ${result.code}: ${detail}`;
      recordFailure(ledger, manager, name, entry.spec, error, now());
      log(`[${manager}] ${name} update failed (exit ${result.code}).`);
      return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
    }
  }
  const verify = verifyCommand(manager, name);
  const verified = await runner(verify.command, verify.args);
  const detected = verified.code === 0 ? parseInstalledVersion(manager, name, verified.stdout) : null;
  if (verified.code !== 0 || !verificationConfirms(manager, name, verified.stdout, detected)) {
    const error = 'update verification failed';
    recordFailure(ledger, manager, name, entry.spec, error, now());
    return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
  }
  const version = detected ?? entry.version;
  if (version && entry.version && version !== entry.version) {
    log(`[${manager}] ${name} moved ${entry.version} -> ${version}.`);
  }
  recordInstalled(ledger, manager, name, { spec: entry.spec, version, pin: null, at: now() });
  return { manager, name, spec: entry.spec, status: 'installed', version, action: 'installed' };
}

/** Upgrade only unpinned packages; a pin is a deliberate version, not a stale one. */
export async function autoUpdatePackages(options: {
  manager: InstallManager;
  ledger: Ledger;
  runner: CommandRunner;
  log?: (line: string) => void;
  now?: () => string;
}): Promise<ProvisionOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const outcomes: ProvisionOutcome[] = [];

  for (const [name, entry] of Object.entries(options.ledger.packages[options.manager])) {
    if (entry.status !== 'installed') continue;
    const pin = normalizePin(entry.pin);
    if (pin) {
      log(`[${options.manager}] ${name} is pinned to ${pin}; auto-update skips it.`);
      continue;
    }
    outcomes.push(await upgradePackage({
      manager: options.manager,
      name,
      entry,
      ledger: options.ledger,
      runner: options.runner,
      log,
      now,
    }));
  }

  return outcomes;
}

function upgradeCommand(manager: InstallManager, parsed: ReturnType<typeof parsePackageSpec>): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'upgrade', '-q', parsed.name] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'install', '-q', '--system', '--upgrade', parsed.name] };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', '--no-fund', '--no-audit', `${parsed.name}@latest`] };
    case 'aqua':
      return { command: 'install-github-app', args: [parsed.raw] };
  }
}
