#!/usr/bin/env node
/**
 * Boot-time package provisioning.
 *
 * The entrypoint calls this instead of keeping its own copy of the install
 * rules. It shares parse -> install -> verify -> ledger with the on-demand MCP
 * path, keeps the boot non-blocking (the caller backgrounds it), and writes a
 * small progress file so `GET /api/mcp/status` can report in-flight work.
 */
import { spawn } from 'node:child_process';

import { ledgerFilePath, readLedger, writeLedger, type InstallManager } from './ledger.js';
import { packageNameFromEntry, readMcpConfig } from './mcp.config.js';
import { autoUpdatePackages, provisionPackages, type CommandRunner } from './provision.js';
import { provisionStatePath, writeProvisionState, type ProvisionState } from './provision-state.js';

function csv(value: string | undefined): string[] {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function spawnRunner(): CommandRunner {
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
  for (const manager of ['uv', 'pip', 'npm', 'aqua'] as const) {
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
  const runner = spawnRunner();

  const groups: Array<{ manager: InstallManager; packages: string[] }> = [
    { manager: 'uv', packages: csv(env.UV_TOOLS) },
    { manager: 'pip', packages: csv(env.PIP_PACKAGES) },
    { manager: 'npm', packages: csv(env.NPM_PACKAGES) },
    { manager: 'aqua', packages: csv(env.GITHUB_APPS) },
  ];

  const state: ProvisionState = {
    running: true,
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
