#!/usr/bin/env node
/**
 * Boot-time package provisioning.
 *
 * The entrypoint calls this instead of keeping its own copy of the install
 * rules. It shares parse -> install -> verify -> ledger with the on-demand MCP
 * path, keeps the boot non-blocking (the caller backgrounds it), and writes a
 * small progress file so `GET /api/mcp/status` can report in-flight work.
 */
import { adoptSeeds, desiredPackagesPath, envSeeds, readDesired, writeDesired } from './desired.js';
import { ledgerFilePath, readLedger, writeLedger, type InstallManager } from './ledger.js';
import { packageNameFromEntry, readMcpConfig } from './mcp.config.js';
import { parsePackageSpec } from './pins.js';
import { autoUpdatePackages, provisionPackages, serverPackages, spawnCommandRunner } from './provision.js';
import { provisionStatePath, writeProvisionState, type ProvisionState } from './provision-state.js';

async function pinsFromConfigAndLedger(ledger: Awaited<ReturnType<typeof readLedger>>): Promise<Record<string, string | null>> {
  const pins: Record<string, string | null> = {};
  try {
    const config = await readMcpConfig('global');
    for (const entry of Object.values(config.mcpServers)) {
      const pkg = packageNameFromEntry(entry);
      if (pkg && entry.pin) pins[pkg.name] = entry.pin;
    }
  } catch {
    // A malformed mcp.json must not stop package provisioning.
  }
  for (const manager of ['uv', 'pip', 'npm', 'aqua', 'apt', 'android'] as const) {
    for (const [name, entry] of Object.entries(ledger.packages[manager])) {
      if (entry.pin) pins[name] = entry.pin;
    }
  }
  return pins;
}

async function main(): Promise<void> {
  const env = process.env;
  const ledgerFile = ledgerFilePath(env);
  const stateFile = provisionStatePath(env);
  const ledger = await readLedger(ledgerFile);
  const pins = await pinsFromConfigAndLedger(ledger);
  const autoUpdate = env.AUTO_UPDATE_PACKAGES === 'true' || env.AUTO_UPDATE_PACKAGES === '1';
  const runner = spawnCommandRunner();

  const seeds = envSeeds(env);
  const groups: Array<{ manager: InstallManager; packages: string[] }> = (['uv', 'pip', 'npm', 'aqua', 'apt', 'android'] as const)
    .map((manager) => ({
      manager,
      packages: seeds.filter((seed) => seed.manager === manager).map((seed) => seed.spec),
    }));

  // Packages added from Settings live beside the ledger; boot treats them the
  // same as the env seeds, so there is one install path, not two.
  const desiredFile = desiredPackagesPath(env);
  const desired = await readDesired(desiredFile);
  if (adoptSeeds(desired, seeds, new Date().toISOString())) {
    try {
      await writeDesired(desiredFile, desired);
    } catch (error) {
      // A read-only config mount must not stop provisioning: the env seeds
      // still install this boot, they just are not persisted.
      console.error(`[provision] could not persist ${desiredFile}: ${error instanceof Error ? error.message : error}`);
    }
  }
  for (const group of groups) {
    for (const [name, entry] of Object.entries(desired.packages[group.manager])) {
      if (!group.packages.some((spec) => parsePackageSpec(spec).name === name)) group.packages.push(entry.spec);
      if (entry.pin) pins[name] = entry.pin;
    }
  }

  // The MCP config is the third source: a server that runs a package gets that
  // package installed on the mount and upgraded on later boots, so its row has
  // a version to pin and the launcher cannot sit on a stale cache.
  try {
    const config = await readMcpConfig('global');
    const fromServers = serverPackages(config.mcpServers);
    for (const pkg of fromServers) {
      const group = groups.find((candidate) => candidate.manager === pkg.manager);
      if (group && !group.packages.some((spec) => parsePackageSpec(spec).name === pkg.name)) group.packages.push(pkg.spec);
      if (pkg.pin) pins[pkg.name] = pkg.pin;
    }
    if (fromServers.length > 0) console.log(`[provision] ${fromServers.length} package(s) from the MCP config.`);
  } catch (error) {
    console.error(`[provision] could not read the MCP config: ${error instanceof Error ? error.message : error}`);
  }

  const state: ProvisionState = {
    running: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    completed: 0,
    failed: 0,
    managers: {},
  };
  await writeProvisionState(stateFile, state);

  for (const group of groups) {
    state.managers = { ...(state.managers ?? {}), [group.manager]: { startedAt: new Date().toISOString() } };
    try {
      const outcomes = await provisionPackages({
        manager: group.manager,
        packages: group.packages,
        ledger,
        runner,
        pins,
        onProgress: async (progress) => {
          state.current = { manager: group.manager, package: progress.package };
          await writeProvisionState(stateFile, state);
        },
      });
      state.completed += outcomes.filter((outcome) => outcome.status === 'installed').length;
      state.failed += outcomes.filter((outcome) => outcome.status === 'failed').length;

      if (autoUpdate) {
        const updated = await autoUpdatePackages({ manager: group.manager, ledger, runner });
        state.completed += updated.filter((outcome) => outcome.status === 'installed').length;
        state.failed += updated.filter((outcome) => outcome.status === 'failed').length;
      }
    } catch (error) {
      // One manager failing must not deny the remaining managers their turn.
      state.failed += 1;
      console.error(`[provision] ${group.manager} failed: ${error instanceof Error ? error.message : error}`);
    }
    await writeLedger(ledgerFile, ledger);
    state.managers = { ...(state.managers ?? {}), [group.manager]: { ...(state.managers?.[group.manager] ?? {}), finishedAt: new Date().toISOString() } };
    await writeProvisionState(stateFile, state);
  }

  delete state.current;
  state.running = false;
  state.finishedAt = new Date().toISOString();
  await writeProvisionState(stateFile, state);
  await writeLedger(ledgerFile, ledger);
  console.log(`[provision] finished: ${state.completed} installed, ${state.failed} failed.`);
}

void main().catch((error) => {
  // Provisioning never aborts the boot; the ledger records what failed.
  console.error(`[provision] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 0;
});
