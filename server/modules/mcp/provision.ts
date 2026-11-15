import { recordFailure, recordInstalled, type InstallManager, type Ledger } from './ledger.js';
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

export function verifyCommand(manager: InstallManager, name: string): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'list'] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'show', name] };
    case 'npm':
      return { command: 'npm', args: ['ls', '-g', '--json', '--depth=0', name] };
    case 'aqua':
      return { command: 'aqua', args: ['list'] };
  }
}

/** Exit 0 alone is not proof: `uv tool list` succeeds on an empty tool set. */
function verificationConfirms(manager: InstallManager, name: string, output: string, version: string | null): boolean {
  if (manager === 'uv') return version !== null || output.includes(name);
  if (manager === 'aqua') return output.includes(name);
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
    outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'installed', version });
  }

  return outcomes;
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
    const parsed = parsePackageSpec(entry.spec);
    const upgrade = upgradeCommand(options.manager, parsed);
    const result = await options.runner(upgrade.command, upgrade.args);
    if (result.code !== 0) {
      recordFailure(options.ledger, options.manager, name, entry.spec, `update exit ${result.code}: ${tailLines(result.stderr || result.stdout)}`, now());
      log(`[${options.manager}] ${name} update failed (exit ${result.code}).`);
      continue;
    }
    const verify = verifyCommand(options.manager, name);
    const verified = await options.runner(verify.command, verify.args);
    if (verified.code !== 0) {
      recordFailure(options.ledger, options.manager, name, entry.spec, 'update verification failed', now());
      continue;
    }
    const detected = parseInstalledVersion(options.manager, name, verified.stdout);
    if (!verificationConfirms(options.manager, name, verified.stdout, detected)) {
      recordFailure(options.ledger, options.manager, name, entry.spec, 'update verification failed', now());
      continue;
    }
    const version = detected ?? entry.version;
    if (version && entry.version && version !== entry.version) {
      log(`[${options.manager}] ${name} moved ${entry.version} -> ${version}.`);
    }
    recordInstalled(options.ledger, options.manager, name, { spec: entry.spec, version, pin: null, at: now() });
    outcomes.push({ manager: options.manager, name, spec: entry.spec, status: 'installed', version });
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
