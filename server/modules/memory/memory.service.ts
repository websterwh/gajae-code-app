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
  type MemoryProvider,
  type YamlBlock,
} from './memory.config.js';
import {
  installMempalaceHook,
  mempalaceCommand,
  MEMPALACE_SERVER,
  mempalaceVersion,
  probeMempalaceFiles,
  runMempalace,
} from './mempalace.js';

const PROVIDERS: readonly MemoryProvider[] = ['off', 'local', 'hindsight', 'mempalace'];
const SCOPINGS = ['global', 'per-project', 'per-project-tagged'] as const;
type HindsightScoping = (typeof SCOPINGS)[number];

export type MemoryView = {
  provider: MemoryProvider;
  /** The backend `config.yml` actually carries; MemPalace runs outside it. */
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
    hookInstalled: boolean;
    mcpServer: 'enabled' | 'disabled' | 'missing';
  };
};

export type MemoryPatch = {
  provider?: unknown;
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
    // entry and the hook but no marker, so report what is actually running
    // instead of calling it the CLI's local pipeline.
    const provider: MemoryProvider = marker?.provider === 'mempalace'
      ? 'mempalace'
      : !marker && mcpServer === 'enabled' && probe.hookInstalled
        ? 'mempalace'
        : backend;

    const version = probe.installed ? await mempalaceVersion(probe.binary) : null;

    return {
      provider,
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
        enabled: provider === 'mempalace',
        installed: probe.installed,
        version,
        palacePath: probe.palacePath,
        palaceInitialized: probe.palaceInitialized,
        hookInstalled: probe.hookInstalled,
        mcpServer,
      },
    };
  }

  /**
   * Selecting MemPalace turns the CLI's own pipeline off — the palace is the
   * memory — and leaves the backend field at `off` so the two never both run.
   * The MCP entry and the hook are what make it reachable and automatic.
   */
  private async enableMempalace(): Promise<void> {
    const blocks = readMemoryBlocks(await this.configText());
    const nextMemory: YamlBlock = { ...blocks.memory, backend: 'off' };
    await writeMemoryConfigText(writeMemoryBlocks(await this.configText(), { memory: nextMemory }), this.env);

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
    if (patch.provider === undefined) {
      if (patch.hindsight) return this.updateHindsight(patch.hindsight);
      throw new Error('provider is required.');
    }
    if (!PROVIDERS.includes(patch.provider as MemoryProvider)) {
      throw new Error('provider must be off, local, hindsight or mempalace.');
    }
    const provider = patch.provider as MemoryProvider;

    if (provider === 'mempalace') {
      await this.enableMempalace();
      return this.status();
    }

    await this.disableMempalace();
    const blocks = readMemoryBlocks(await this.configText());
    const nextMemory: YamlBlock = { ...blocks.memory, backend: provider };
    const nextBlocks: Partial<Record<'memory' | 'hindsight', YamlBlock>> = { memory: nextMemory };
    if (provider === 'hindsight' && patch.hindsight) {
      nextBlocks.hindsight = this.applyHindsight(blocks.hindsight, patch.hindsight);
    }
    const text = await this.configText();
    await writeMemoryConfigText(writeMemoryBlocks(text, nextBlocks), this.env);
    return this.status();
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
    const text = await this.configText();
    await writeMemoryConfigText(
      writeMemoryBlocks(text, { hindsight: this.applyHindsight(blocks.hindsight, patch) }),
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
    const result = await runMempalace(['init', projectPath], { env: this.env, cwd: projectPath });
    if (result.code !== 0) {
      throw new Error(`mempalace init failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    }
    return { output: (result.stdout || result.stderr).trim() };
  }

  /**
   * Mines a markdown file or directory into the palace. The CLI defaults to
   * docs mode, which is what memory notes and MEMORY.md exports are.
   */
  async importPath(input: MemoryActionInput): Promise<{ output: string }> {
    const target = text(input.path);
    if (!path.isAbsolute(target)) throw new Error('path must be an absolute path.');
    if (!existsSync(target)) throw new Error('path does not exist.');
    const args = ['mine', target];
    const mode = text(input.mode);
    if (mode) args.push('--mode', mode);
    const result = await runMempalace(args, { env: this.env, cwd: path.dirname(target) });
    if (result.code !== 0) {
      throw new Error(`mempalace mine failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    }
    return { output: (result.stdout || result.stderr).trim() };
  }
}

export const memoryService = new MemoryService();
