import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { INSTALL_MANAGERS, ledgerFilePath, type InstallManager } from './ledger.js';

/**
 * Packages the user asked for, as opposed to packages the ledger observed.
 *
 * The env vars (UV_TOOLS, PIP_PACKAGES, ...) seed this list; Settings adds to
 * it. It lives beside the ledger under the config mount, so a package added in
 * the UI is still wanted after the container is recreated, and the ledger can
 * stay a cache of the last verified install.
 */
export type DesiredPackage = {
  manager: InstallManager;
  spec: string;
  pin: string | null;
  addedAt: string;
};
export type DesiredState = {
  version: 1;
  packages: Record<InstallManager, Record<string, DesiredPackage>>;
};

export type EnvSeed = { manager: InstallManager; spec: string };

export const ENV_PACKAGE_VARIABLES: ReadonlyArray<{ manager: InstallManager; variable: string }> = [
  { manager: 'uv', variable: 'UV_TOOLS' },
  { manager: 'pip', variable: 'PIP_PACKAGES' },
  { manager: 'npm', variable: 'NPM_PACKAGES' },
  { manager: 'aqua', variable: 'GITHUB_APPS' },
];

export function emptyDesired(): DesiredState {
  return { version: 1, packages: { uv: {}, pip: {}, npm: {}, aqua: {} } };
}

export function envSeeds(env: NodeJS.ProcessEnv = process.env): EnvSeed[] {
  const seeds: EnvSeed[] = [];
  for (const { manager, variable } of ENV_PACKAGE_VARIABLES) {
    for (const spec of String(env[variable] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
      seeds.push({ manager, spec });
    }
  }
  return seeds;
}

/** Next to the ledger, which is already on the config mount. */
export function desiredPackagesPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GJC_DESIRED_PACKAGES) return path.resolve(env.GJC_DESIRED_PACKAGES);
  return path.join(path.dirname(ledgerFilePath(env)), 'packages.json');
}

export async function readDesired(file: string): Promise<DesiredState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DesiredState>;
    const state = emptyDesired();
    for (const manager of INSTALL_MANAGERS) {
      const bucket = parsed.packages?.[manager];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [name, entry] of Object.entries(bucket)) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.spec !== 'string' || !entry.spec.trim()) continue;
        state.packages[manager][name] = {
          manager,
          spec: entry.spec,
          pin: typeof entry.pin === 'string' && entry.pin ? entry.pin : null,
          addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date(0).toISOString(),
        };
      }
    }
    return state;
  } catch {
    // Missing or malformed means "the user added nothing here", never "remove".
    return emptyDesired();
  }
}

export async function writeDesired(file: string, state: DesiredState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function upsertDesired(
  state: DesiredState,
  entry: { manager: InstallManager; name: string; spec: string; pin: string | null; addedAt: string },
): DesiredPackage {
  const next: DesiredPackage = {
    manager: entry.manager,
    spec: entry.spec,
    pin: entry.pin,
    addedAt: state.packages[entry.manager][entry.name]?.addedAt ?? entry.addedAt,
  };
  state.packages[entry.manager][entry.name] = next;
  return next;
}

export function removeDesired(state: DesiredState, manager: InstallManager, name: string): void {
  delete state.packages[manager][name];
}
