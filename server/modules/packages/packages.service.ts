import {
  desiredPackagesPath,
  envSeeds,
  INSTALL_MANAGERS,
  ledgerFilePath,
  normalizePin,
  parsePackageSpec,
  provisionPackages,
  provisionStatePath,
  readDesired,
  readLedger,
  readProvisionState,
  removeDesired,
  spawnCommandRunner,
  uninstallPackage,
  upgradePackage,
  upsertDesired,
  writeDesired,
  writeLedger,
  type CommandRunner,
  type InstallManager,
  type Ledger,
  type LedgerEntry,
} from '../mcp/index.js';

export type PackageStatus = 'installed' | 'failed' | 'missing';
export type PackageSource = 'env' | 'ui' | 'installed';

export type PackageRow = {
  manager: InstallManager;
  name: string;
  spec: string;
  pin: string | null;
  /** env: seeded by the container; ui: added here; installed: only observed in the ledger. */
  source: PackageSource;
  desired: boolean;
  status: PackageStatus;
  version: string | null;
  /** An install for this row is running right now; the page polls until it stops. */
  installing?: boolean;
  error?: string;
  updatedAt?: string;
};

export type PackagesServiceOptions = {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  ledgerPath?: string;
  desiredPath?: string;
  statePath?: string;
  now?: () => string;
};

function managerOf(value: unknown): InstallManager {
  if (typeof value !== 'string' || !INSTALL_MANAGERS.includes(value as InstallManager)) {
    throw new Error('manager must be one of uv, pip, npm, aqua, apt or android.');
  }
  return value as InstallManager;
}

function observed(entry: LedgerEntry): { status: PackageStatus; error?: string; updatedAt?: string } {
  const failed = entry.status === 'failed' || entry.lastAttempt?.status === 'failed';
  const updatedAt = entry.lastAttempt?.at ?? entry.installedAt;
  return {
    status: failed ? 'failed' : entry.status === 'installed' ? 'installed' : 'missing',
    ...(failed && entry.error ? { error: entry.error } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * One list for both halves of package management: what was asked for (env
 * seeds plus Settings additions) and what the ledger last observed. Installs,
 * upgrades and pins all run through the same provisioner the boot uses.
 */
export class PackagesService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CommandRunner;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: PackagesServiceOptions = {}) {
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.runner = options.runner ?? spawnCommandRunner();
  }

  private ledgerFile(): string {
    return this.options.ledgerPath ?? ledgerFilePath(this.env);
  }

  private desiredFile(): string {
    return this.options.desiredPath ?? desiredPackagesPath(this.env);
  }

  private stateFile(): string {
    return this.options.statePath ?? provisionStatePath(this.env);
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  /** Installs take minutes; two at once would fight over the same tool dirs. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(): Promise<PackageRow[]> {
    const [ledger, desired] = await Promise.all([readLedger(this.ledgerFile()), readDesired(this.desiredFile())]);
    const rows = new Map<string, PackageRow>();
    const id = (manager: InstallManager, name: string): string => `${manager}:${name}`;

    for (const seed of envSeeds(this.env)) {
      const parsed = parsePackageSpec(seed.spec);
      if (!parsed.name) continue;
      rows.set(id(seed.manager, parsed.name), {
        manager: seed.manager,
        name: parsed.name,
        spec: seed.spec,
        pin: desired.packages[seed.manager][parsed.name]?.pin ?? null,
        source: 'env',
        desired: true,
        status: 'missing',
        version: null,
      });
    }

    for (const manager of INSTALL_MANAGERS) {
      for (const [name, entry] of Object.entries(desired.packages[manager])) {
        const existing = rows.get(id(manager, name));
        if (existing) {
          existing.spec = entry.spec;
          existing.pin = entry.pin;
          continue;
        }
        rows.set(id(manager, name), {
          manager,
          name,
          spec: entry.spec,
          pin: entry.pin,
          source: 'ui',
          desired: true,
          status: 'missing',
          version: null,
        });
      }
    }

    for (const manager of INSTALL_MANAGERS) {
      for (const [name, entry] of Object.entries(ledger.packages[manager])) {
        const seen = observed(entry);
        const existing = rows.get(id(manager, name));
        if (existing) {
          existing.status = seen.status;
          existing.version = entry.version;
          if (seen.error) existing.error = seen.error;
          if (seen.updatedAt) existing.updatedAt = seen.updatedAt;
          continue;
        }
        rows.set(id(manager, name), {
          manager,
          name,
          spec: entry.spec,
          pin: entry.pin ?? null,
          source: 'installed',
          desired: false,
          status: seen.status,
          version: entry.version,
          ...(seen.error ? { error: seen.error } : {}),
          ...(seen.updatedAt ? { updatedAt: seen.updatedAt } : {}),
        });
      }
    }

    for (const row of rows.values()) {
      if (this.inFlight.has(id(row.manager, row.name))) row.installing = true;
    }

    const order = new Map(INSTALL_MANAGERS.map((manager, index) => [manager, index]));
    return [...rows.values()].sort((a, b) => (
      (order.get(a.manager) ?? 0) - (order.get(b.manager) ?? 0) || a.name.localeCompare(b.name)
    ));
  }

  async add(input: { manager?: unknown; spec?: unknown; pin?: unknown }): Promise<PackageRow> {
    const manager = managerOf(input.manager);
    const spec = String(input.spec ?? '').trim();
    if (!spec) throw new Error('A package spec is required.');
    const parsed = parsePackageSpec(spec);
    if (!parsed.name) throw new Error('The package spec has no name.');
    const pin = normalizePin(input.pin);

    return this.serialize(async () => {
      const key = `${manager}:${parsed.name}`;
      this.inFlight.add(key);
      try {
        const desired = await readDesired(this.desiredFile());
        upsertDesired(desired, { manager, name: parsed.name, spec, pin, addedAt: this.now() });
        await writeDesired(this.desiredFile(), desired);
        return await this.install(manager, spec, parsed.name, pin);
      } finally {
        this.inFlight.delete(key);
      }
    });
  }

  /**
   * Start an install without holding the HTTP response open for it.
   *
   * A cargo build or an apt download runs for minutes; the page polls `list()`
   * instead, where the row reports `installing` until the work has finished or
   * been recorded as failed. The install itself is still serialized, so two
   * clicks queue instead of fighting over the same tool directories.
   */
  queue(input: { manager?: unknown; spec?: unknown; pin?: unknown }): PackageRow {
    const manager = managerOf(input.manager);
    const spec = String(input.spec ?? '').trim();
    if (!spec) throw new Error('A package spec is required.');
    const parsed = parsePackageSpec(spec);
    if (!parsed.name) throw new Error('The package spec has no name.');
    const pin = normalizePin(input.pin);
    void this.add({ manager, spec, pin }).catch((error: unknown) => {
      // The outcome is in the ledger and shows on the row; the request that
      // queued this install has already answered.
      console.error(`[packages] ${manager}:${parsed.name} install failed:`, error instanceof Error ? error.message : error);
    });
    return { manager, name: parsed.name, spec, pin, source: 'ui', desired: true, status: 'missing', version: null, installing: true };
  }

  /** Pinning reinstalls at that version when the installed one differs. */
  async setPin(managerValue: unknown, name: string, value: unknown): Promise<PackageRow> {
    const manager = managerOf(managerValue);
    // An SDK component names its own revision (`build-tools;35.0.0`), and that
    // name is what sdkmanager installs. A pin here would not change what is
    // installed; it would only stop the component being updated.
    if (manager === 'android') {
      throw new Error('Android SDK components cannot be pinned; name the revision instead, for example build-tools;35.0.0.');
    }
    const pin = normalizePin(value);

    return this.serialize(async () => {
      const key = `${manager}:${name}`;
      this.inFlight.add(key);
      try {
        const desired = await readDesired(this.desiredFile());
        const entry = desired.packages[manager][name];
        // A package seeded by the container has no desired entry yet, and one
        // installed by a catalog entry (mobile MCP, say) exists only in the
        // ledger. Both can be pinned, so the spec is read from whichever row
        // this was listed from.
        const seed = envSeeds(this.env).find((row) => (
          row.manager === manager && parsePackageSpec(row.spec).name === name
        ));
        const ledger = entry || seed ? null : await readLedger(this.ledgerFile());
        const spec = entry?.spec ?? seed?.spec ?? ledger?.packages[manager][name]?.spec;
        if (!spec) throw new Error('Package was not found.');
        upsertDesired(desired, { manager, name, spec, pin, addedAt: this.now() });
        await writeDesired(this.desiredFile(), desired);
        return await this.install(manager, spec, name, pin);
      } finally {
        this.inFlight.delete(key);
      }
    });
  }

  async upgrade(managerValue: unknown, name: string): Promise<PackageRow> {
    const manager = managerOf(managerValue);

    return this.serialize(async () => {
      const ledger = await readLedger(this.ledgerFile());
      const entry = ledger.packages[manager][name];
      if (!entry) throw new Error('Package was not found.');
      if (normalizePin(entry.pin)) throw new Error('This package is pinned; unpin it before upgrading.');
      const outcome = await upgradePackage({ manager, name, entry, ledger, runner: this.runner, now: () => this.now() });
      await writeLedger(this.ledgerFile(), ledger);
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'The upgrade failed.');
      return this.row(manager, name);
    });
  }

  /** Uninstall first, then forget: a failed removal leaves the row to retry. */
  async remove(managerValue: unknown, name: string): Promise<void> {
    const manager = managerOf(managerValue);

    await this.serialize(async () => {
      const [desired, ledger] = await Promise.all([
        readDesired(this.desiredFile()),
        readLedger(this.ledgerFile()),
      ]);
      const spec = desired.packages[manager][name]?.spec
        ?? ledger.packages[manager][name]?.spec
        ?? name;
      const outcome = await uninstallPackage({ manager, spec, runner: this.runner });
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'The uninstall failed.');

      removeDesired(desired, manager, name);
      await writeDesired(this.desiredFile(), desired);
      delete ledger.packages[manager][name];
      await writeLedger(this.ledgerFile(), ledger);
    });
  }

  private async install(manager: InstallManager, spec: string, name: string, pin: string | null): Promise<PackageRow> {
    const state = await readProvisionState(this.stateFile());
    if (state?.running) throw new Error('Package provisioning is already running. Try again when it finishes.');

    const ledger: Ledger = await readLedger(this.ledgerFile());
    const outcomes = await provisionPackages({
      manager,
      packages: [spec],
      ledger,
      runner: this.runner,
      pins: { [name]: pin },
      now: () => this.now(),
    });
    await writeLedger(this.ledgerFile(), ledger);

    const outcome = outcomes[0];
    if (outcome?.status === 'failed') throw new Error(outcome.error ?? 'The package install failed.');
    return this.row(manager, name);
  }

  private async row(manager: InstallManager, name: string): Promise<PackageRow> {
    const row = (await this.list()).find((item) => item.manager === manager && item.name === name);
    if (!row) throw new Error('Package was not found.');
    return row;
  }
}

export const packagesService = new PackagesService();
