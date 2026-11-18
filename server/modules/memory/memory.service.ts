import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { agentDir, readMcpConfig, writeMcpConfig, type McpFile } from '../mcp/index.js';

import {
  clearMemoryProviderMarker,
  readMemoryBlocks,
  readMemoryConfigText,
  readMemoryProviderMarker,
  writeMemoryBlocks,
  writeMemoryConfigText,
  writeMemoryProviderMarker,
  type MemoryBackend,
  type YamlBlock,
} from './memory.config.js';
import {
  installMempalace,
  installMempalaceHook,
  mempalaceCommand,
  MEMPALACE_SERVER,
  mempalaceProjectInitialized,
  mempalaceStats,
  mempalaceVersion,
  probeMempalaceFiles,
  runMempalace,
} from './mempalace.js';

const BACKENDS: readonly MemoryBackend[] = ['off', 'local', 'hindsight'];
const SCOPINGS = ['global', 'per-project', 'per-project-tagged'] as const;
type HindsightScoping = (typeof SCOPINGS)[number];

export type MemoryView = {
  /** The backend `config.yml` carries; MemPalace runs beside it, not instead of it. */
  backend: MemoryBackend;
  local: { directory: string; projects: number };
  hindsight: {
    apiUrl: string;
    bankId: string;
    scoping: HindsightScoping;
    autoRecall: boolean;
    autoRetain: boolean;
    hasToken: boolean;
  };
  mempalace: {
    enabled: boolean;
    installed: boolean;
    version: string | null;
    palacePath: string;
    palaceInitialized: boolean;
    /** Counts from `mempalace status`; null until the palace database exists. */
    stats: { drawers: number; wings: number; rooms: number } | null;
    hookInstalled: boolean;
    mcpServer: 'enabled' | 'disabled' | 'missing';
  };
};

export type MemoryPatch = {
  provider?: unknown;
  mempalace?: unknown;
  hindsight?: {
    apiUrl?: unknown;
    apiToken?: unknown;
    bankId?: unknown;
    scoping?: unknown;
    autoRecall?: unknown;
    autoRetain?: unknown;
  };
};

export type MemoryActionInput = { projectPath?: unknown; path?: unknown; mode?: unknown };

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const backendOf = (block: YamlBlock): MemoryBackend => {
  const value = block.backend;
  return value === 'local' || value === 'hindsight' ? value : 'off';
};

const scopingOf = (block: YamlBlock): HindsightScoping => {
  const value = block.scoping;
  return typeof value === 'string' && (SCOPINGS as readonly string[]).includes(value)
    ? value as HindsightScoping
    : 'per-project-tagged';
};

const textOf = (block: YamlBlock, key: string, fallback = ''): string => {
  const value = block[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
};

/** Existing project memory directories, one per workspace the CLI has seen. */
async function localMemoryProjects(env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const entries = await readdir(path.join(agentDir(env), 'memories'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

export class MemoryService {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async configText(): Promise<string> {
    return readMemoryConfigText(this.env);
  }

  private async mcpFile(): Promise<McpFile> {
    return readMcpConfig('global', undefined, this.env);
  }

  async status(): Promise<MemoryView> {
    const blocks = readMemoryBlocks(await this.configText());
    const marker = await readMemoryProviderMarker(this.env);
    const backend = backendOf(blocks.memory);
    const probe = probeMempalaceFiles(this.env);
    const mcp = await this.mcpFile();
    const entry = mcp.mcpServers[MEMPALACE_SERVER];
    const mcpServer = entry
      ? entry.enabled === false || mcp.disabledServers?.includes(MEMPALACE_SERVER)
        ? 'disabled'
        : 'enabled'
      : 'missing';

    // An instance that enabled MemPalace before this page existed has the MCP
    // entry and the hook but no marker, so read what is actually running.
    const enabled = marker?.provider === 'mempalace'
      || (!marker && mcpServer === 'enabled' && probe.hookInstalled);

    // Version and counts are two CLI starts; running them together keeps the
    // Memory tab from paying for both one after the other.
    const [version, stats] = await Promise.all([
      probe.installed ? mempalaceVersion(probe.binary) : Promise.resolve(null),
      probe.installed && probe.palaceInitialized ? mempalaceStats(probe.binary, this.env) : Promise.resolve(null),
    ]);

    return {
      backend,
      local: {
        directory: path.join(agentDir(this.env), 'memories'),
        projects: await localMemoryProjects(this.env),
      },
      hindsight: {
        apiUrl: textOf(blocks.hindsight, 'apiUrl', 'http://localhost:8888'),
        bankId: textOf(blocks.hindsight, 'bankId'),
        scoping: scopingOf(blocks.hindsight),
        autoRecall: blocks.hindsight.autoRecall !== false,
        autoRetain: blocks.hindsight.autoRetain !== false,
        hasToken: textOf(blocks.hindsight, 'apiToken').length > 0,
      },
      mempalace: {
        enabled,
        installed: probe.installed,
        version,
        palacePath: probe.palacePath,
        palaceInitialized: probe.palaceInitialized,
        stats,
        hookInstalled: probe.hookInstalled,
        mcpServer,
      },
    };
  }

  /**
   * MemPalace is an MCP server plus an autosave hook, so it can run beside the
   * CLI's own backend. Turning it on wires those two pieces and never rewrites
   * the `memory` block, which is what makes local/Hindsight recall still work.
   */
  private async enableMempalace(): Promise<void> {
    const install = await installMempalace(this.env);
    if (install.attempted && !install.installed) {
      throw new Error(`mempalace install failed: ${install.output || 'the installer produced no binary'}`);
    }

    const file = await this.mcpFile();
    file.mcpServers[MEMPALACE_SERVER] = {
      ...file.mcpServers[MEMPALACE_SERVER],
      type: 'stdio',
      command: mempalaceCommand('mempalace-mcp', this.env),
      args: [],
      enabled: true,
    };
    if (file.disabledServers) {
      file.disabledServers = file.disabledServers.filter((name) => name !== MEMPALACE_SERVER);
      if (!file.disabledServers.length) delete file.disabledServers;
    }
    await writeMcpConfig('global', undefined, file, this.env);
    await installMempalaceHook(this.env);
    await writeMemoryProviderMarker('mempalace', this.env);
  }

  private async disableMempalace(): Promise<void> {
    const file = await this.mcpFile();
    const entry = file.mcpServers[MEMPALACE_SERVER];
    if (entry) {
      entry.enabled = false;
      delete entry.disabled;
      await writeMcpConfig('global', undefined, file, this.env);
    }
    await clearMemoryProviderMarker(this.env);
  }

  async update(patch: MemoryPatch): Promise<MemoryView> {
    if (patch.provider === undefined && patch.mempalace === undefined) {
      if (patch.hindsight) return this.updateHindsight(patch.hindsight);
      throw new Error('provider or mempalace is required.');
    }
    if (patch.mempalace !== undefined && typeof patch.mempalace !== 'boolean') {
      throw new Error('mempalace must be true or false.');
    }

    if (patch.provider !== undefined) {
      // `mempalace` was the provider value before it became an independent
      // toggle; keep accepting it so an older client still works.
      if (patch.provider === 'mempalace') {
        await this.enableMempalace();
      } else if (!BACKENDS.includes(patch.provider as MemoryBackend)) {
        throw new Error('provider must be off, local or hindsight.');
      } else {
        await this.setBackend(patch.provider as MemoryBackend, patch.hindsight);
      }
    }

    if (patch.mempalace === true) await this.enableMempalace();
    else if (patch.mempalace === false) await this.disableMempalace();

    return this.status();
  }

  private async setBackend(provider: MemoryBackend, hindsight?: MemoryPatch['hindsight']): Promise<void> {
    const blocks = readMemoryBlocks(await this.configText());
    const nextMemory: YamlBlock = { ...blocks.memory, backend: provider };
    const nextBlocks: Partial<Record<'memory' | 'hindsight', YamlBlock>> = { memory: nextMemory };
    if (provider === 'hindsight' && hindsight) nextBlocks.hindsight = this.applyHindsight(blocks.hindsight, hindsight);
    await writeMemoryConfigText(writeMemoryBlocks(await this.configText(), nextBlocks), this.env);
  }

  /** A blank token means "keep the stored one", exactly like the notify form. */
  private applyHindsight(current: YamlBlock, patch: NonNullable<MemoryPatch['hindsight']>): YamlBlock {
    const next: YamlBlock = { ...current };
    const apiUrl = text(patch.apiUrl);
    if (apiUrl) next.apiUrl = apiUrl;
    const apiToken = text(patch.apiToken);
    if (apiToken) next.apiToken = apiToken;
    if (patch.bankId !== undefined) next.bankId = text(patch.bankId) || null;
    if (typeof patch.scoping === 'string' && (SCOPINGS as readonly string[]).includes(patch.scoping)) {
      next.scoping = patch.scoping;
    }
    if (typeof patch.autoRecall === 'boolean') next.autoRecall = patch.autoRecall;
    if (typeof patch.autoRetain === 'boolean') next.autoRetain = patch.autoRetain;
    return next;
  }

  private async updateHindsight(patch: NonNullable<MemoryPatch['hindsight']>): Promise<MemoryView> {
    const blocks = readMemoryBlocks(await this.configText());
    await writeMemoryConfigText(
      writeMemoryBlocks(await this.configText(), { hindsight: this.applyHindsight(blocks.hindsight, patch) }),
      this.env,
    );
    return this.status();
  }

  /**
   * `mempalace init` detects rooms from a project's folder structure and writes
   * the project's palace metadata, so it has to run against a real directory.
   */
  async initPalace(input: MemoryActionInput): Promise<{ output: string }> {
    const projectPath = text(input.projectPath);
    if (!path.isAbsolute(projectPath)) throw new Error('projectPath must be an absolute path.');
    if (!existsSync(projectPath) || !(await stat(projectPath)).isDirectory()) {
      throw new Error('projectPath does not exist or is not a directory.');
    }
    await this.enableMempalace();
    // --yes accepts the detected rooms without a prompt; stdin is ignored here,
    // so an interactive question would otherwise stall until the timeout.
    const result = await runMempalace(['init', projectPath, '--yes'], {
      env: this.env,
      cwd: projectPath,
      timeoutMs: 180_000,
    });
    if (result.code !== 0) {
      throw new Error(`mempalace init failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    }
    return { output: (result.stdout || result.stderr).trim() };
  }

  /** Which of the picker's project folders already carry a `mempalace.yaml`. */
  async projectStatus(input: { paths?: unknown } = {}): Promise<{
    projects: Array<{ path: string; initialized: boolean }>;
    initialized: string[];
  }> {
    const values = Array.isArray(input.paths) ? input.paths : [];
    const paths = [...new Set(
      values.filter((value): value is string => typeof value === 'string' && path.isAbsolute(value)),
    )];
    const projects = paths.map((projectPath) => ({
      path: projectPath,
      initialized: mempalaceProjectInitialized(projectPath),
    }));
    return { projects, initialized: projects.filter((row) => row.initialized).map((row) => row.path) };
  }

  /**
   * Mines a markdown file or directory into the palace. With no `--mode` the
   * CLI uses projects mode, which already ingests code and markdown notes, so
   * "docs" is accepted as the blank/default spelling rather than forwarding a
   * value the CLI would reject.
   */
  async importPath(input: MemoryActionInput): Promise<{ output: string }> {
    const target = text(input.path);
    if (!path.isAbsolute(target)) throw new Error('path must be an absolute path.');
    if (!existsSync(target)) throw new Error('path does not exist.');
    const args = ['mine', target];
    const mode = text(input.mode).toLowerCase();
    if (mode && mode !== 'docs' && mode !== 'documentation') {
      if (!['projects', 'convos', 'extract'].includes(mode)) {
        throw new Error('mode must be projects, convos or extract.');
      }
      args.push('--mode', mode);
    }
    const result = await runMempalace(args, { env: this.env, cwd: path.dirname(target) });
    if (result.code !== 0) {
      throw new Error(`mempalace mine failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    }
    return { output: (result.stdout || result.stderr).trim() };
  }
}

export const memoryService = new MemoryService();
