import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  attachGitHubStars,
  bundledCatalog,
  loadOverlay,
  mergeCatalog,
  rankCatalog,
  searchCatalog,
  type CatalogEntry,
  type CatalogSource,
} from './catalog.js';
import {
  failedEntries,
  ledgerFilePath,
  readLedger,
  writeLedger,
  type LedgerEntry,
} from './ledger.js';
import {
  agentDir,
  packageNameFromEntry,
  publicServer,
  readMcpConfig,
  transportOf,
  validateServerInput,
  writeMcpConfig,
  REDACTED,
  type McpScope,
  type McpServerEntry,
  type PublicMcpServer,
} from './mcp.config.js';
import { isDowngrade, normalizePin } from './pins.js';
import { provisionStatePath, readProvisionState } from './provision-state.js';
import { createRegistryClient, type RegistryClient } from './registry-client.js';

export type McpCliRunner = (
  args: string[],
  options: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type McpServerView = PublicMcpServer & { install: LedgerEntry | null };
export type VerifyResult = { ok: boolean; toolCount?: number; tools?: string[]; error?: string };
export type CatalogSort = 'name' | 'relevance' | 'popularity';

export type McpServiceOptions = {
  agentDir?: string;
  runCli?: McpCliRunner;
  fetchImpl?: typeof fetch;
  registryClient?: RegistryClient;
  now?: () => number;
  verifyTimeoutMs?: number;
  ledgerPath?: string;
  statePath?: string;
  catalogCachePath?: string;
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function defaultCliRunner(args: string[], options: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.GJC_CLI_PATH || 'gjc', args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: 124, stdout, stderr: `${stderr}\nThe MCP CLI timed out.` });
    }, 30_000);
    timer.unref();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Only a newly supplied secret replaces a stored one; the redaction marker means "keep". */
function mergeSecrets(existing: Record<string, string> | undefined, incoming: unknown): Record<string, string> {
  const merged = { ...(existing ?? {}) };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return merged;
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (value === REDACTED) continue;
    if (typeof value !== 'string') continue;
    if (value === '') delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

async function verifyStdio(entry: McpServerEntry, timeoutMs: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    if (!entry.command) return resolve({ ok: false, error: 'This server has no command to start.' });
    const child = spawn(entry.command, entry.args ?? [], {
      cwd: entry.cwd,
      env: { ...process.env, ...(entry.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const lines = createInterface({ input: child.stdout! });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let settled = false;
    const finish = (result: VerifyResult) => {
      if (settled) return;
      settled = true;
      for (const call of pending.values()) { clearTimeout(call.timer); }
      pending.clear();
      lines.close();
      child.kill('SIGTERM');
      resolve(result);
    };
    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<unknown>((ok, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`Timed out waiting for ${method}.`)); }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve: ok, reject: fail, timer });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      void method;
    });

    lines.on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id !== 'number') return;
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message || 'The server returned an error.'));
      else call.resolve(message.result);
    });
    child.once('error', (error) => finish({ ok: false, error: error.message }));
    child.once('close', (code) => {
      if (!settled && code !== 0) finish({ ok: false, error: `The server exited with code ${code}.` });
      else if (!settled) finish({ ok: false, error: 'The server closed before completing the handshake.' });
    });

    void (async () => {
      try {
        await request(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gajae-code-app', version: '1' },
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const result = await request(2, 'tools/list', {}) as { tools?: Array<{ name?: string }> };
        const tools = (result.tools ?? []).map((tool) => tool.name).filter((name): name is string => Boolean(name));
        finish({ ok: true, toolCount: tools.length, tools });
      } catch (error) {
        finish({ ok: false, error: messageOf(error, 'The server handshake failed.') });
      }
    })();
  });
}

async function verifyHttp(entry: McpServerEntry, timeoutMs: number): Promise<VerifyResult> {
  if (!entry.url) return { ok: false, error: 'This server has no URL to reach.' };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(entry.headers ?? {}) };
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    const response = await fetch(entry.url as string, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    const text = await response.text();
    const dataLines = text.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    const payload = dataLines.length ? dataLines[dataLines.length - 1] : text;
    const parsed = JSON.parse(payload) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) throw new Error(parsed.error.message || 'The server returned an error.');
    return parsed.result;
  };
  try {
    await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gajae-code-app', version: '1' },
    });
    const result = await call(2, 'tools/list', {}) as { tools?: Array<{ name?: string }> };
    const tools = (result.tools ?? []).map((tool) => tool.name).filter((name): name is string => Boolean(name));
    return { ok: true, toolCount: tools.length, tools };
  } catch (error) {
    return { ok: false, error: messageOf(error, 'The server handshake failed.') };
  }
}

function composeLineFor(server: string, mountPath: string): string {
  const basename = path.basename(mountPath) || 'data';
  return `      - ./data/mcp/${server}/${basename}:${mountPath}`;
}

/**
 * Operates on the one mcp.json the agent itself reads. There is no shadow
 * store: list/get return redacted placeholders, mutations go through
 * `gjc mcp add/remove` where those verbs exist, and toggle/pin edit the parsed
 * file atomically because no CLI verb exists for them.
 */
export class McpService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCli: McpCliRunner;
  private readonly verifyTimeoutMs: number;

  constructor(private readonly options: McpServiceOptions = {}) {
    this.env = options.agentDir
      ? { ...process.env, GJC_WORKER_AGENT_DIR: options.agentDir }
      : { ...process.env };
    this.runCli = options.runCli ?? defaultCliRunner;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 10_000;
  }

  private read(scope: McpScope, projectPath?: string) {
    return readMcpConfig(scope, projectPath, this.env);
  }

  private write(scope: McpScope, projectPath: string | undefined, file: Awaited<ReturnType<typeof readMcpConfig>>) {
    return writeMcpConfig(scope, projectPath, file, this.env);
  }

  private ledgerFile(): string {
    return this.options.ledgerPath ?? ledgerFilePath(this.env);
  }

  private stateFile(): string {
    return this.options.statePath ?? provisionStatePath(this.env);
  }

  private registry(): RegistryClient {
    return this.options.registryClient ?? createRegistryClient({
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  private requireProject(projectPath: string | undefined): string {
    if (!projectPath || !path.isAbsolute(projectPath)) throw new Error('projectPath must be an absolute path for project scope.');
    return projectPath;
  }

  private view(name: string, entry: McpServerEntry, scope: McpScope, ledgerEntries: Record<string, LedgerEntry>): McpServerView {
    const pkg = transportOf(entry) === 'stdio' ? packageNameFromEntry(entry) : null;
    const install = pkg ? ledgerEntries[pkg.name] ?? null : null;
    return { ...publicServer(name, entry, scope), install };
  }

  private async allLedgerEntries(): Promise<Record<string, LedgerEntry>> {
    const ledger = await readLedger(this.ledgerFile());
    return { ...ledger.packages.uv, ...ledger.packages.pip, ...ledger.packages.npm, ...ledger.packages.aqua };
  }

  async list(scope: McpScope | 'all' = 'global', projectPath?: string): Promise<McpServerView[]> {
    const entries = await this.allLedgerEntries();
    const scopes: McpScope[] = scope === 'all'
      ? ['global', ...(projectPath ? ['project' as const] : [])]
      : [scope];
    const servers: McpServerView[] = [];
    for (const current of scopes) {
      const file = await this.read(current, current === 'project' ? this.requireProject(projectPath) : undefined);
      for (const [name, entry] of Object.entries(file.mcpServers)) {
        servers.push(this.view(name, entry, current, entries));
      }
    }
    return servers.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(scope: McpScope, name: string, projectPath?: string): Promise<McpServerView | null> {
    const file = await this.read(scope, scope === 'project' ? this.requireProject(projectPath) : undefined);
    const entry = file.mcpServers[name];
    return entry ? this.view(name, entry, scope, await this.allLedgerEntries()) : null;
  }

  async add(input: unknown): Promise<McpServerView> {
    const validated = validateServerInput(input);
    if ('error' in validated) throw new Error(validated.error);
    const value = validated.value;
    const scope = value.scope ?? 'global';
    const projectPath = scope === 'project' ? this.requireProject(value.projectPath) : undefined;
    const file = await this.read(scope, projectPath);
    if (file.mcpServers[value.name]) throw new Error(`A server named "${value.name}" already exists.`);

    const args = ['mcp', 'add', value.name, '--type', value.transport];
    if (value.command) args.push('--command', value.command);
    for (const arg of value.args ?? []) args.push('--arg', arg);
    for (const [key, envValue] of Object.entries(value.env ?? {})) args.push('--env', `${key}=${envValue}`);
    if (value.url) args.push('--url', value.url);
    // gjc accepts header values as KEY=VALUE; a colon is rejected as invalid.
    for (const [key, headerValue] of Object.entries(value.headers ?? {})) args.push('--header', `${key}=${headerValue}`);
    if (scope === 'project') args.push('--project');

    const result = await this.runCli(args, { ...(projectPath ? { cwd: projectPath } : {}) });
    if (result.code !== 0) throw new Error(`gjc mcp add failed with exit ${result.code}.`);
    const written = await this.read(scope, projectPath);
    const entry = written.mcpServers[value.name];
    if (!entry) throw new Error('gjc mcp add reported success but the server is not in mcp.json.');
    return this.view(value.name, entry, scope, await this.allLedgerEntries());
  }

  async update(scope: McpScope, name: string, patch: Record<string, unknown>, projectPath?: string): Promise<McpServerView> {
    const resolvedProject = scope === 'project' ? this.requireProject(projectPath) : undefined;
    const file = await this.read(scope, resolvedProject);
    const entry = file.mcpServers[name];
    if (!entry) throw new Error('MCP server was not found.');

    if (typeof patch.enabled === 'boolean') entry.disabled = !patch.enabled;
    if ('pin' in patch) entry.pin = normalizePin(patch.pin);
    if (typeof patch.command === 'string') entry.command = patch.command.trim();
    if (Array.isArray(patch.args)) entry.args = patch.args.filter((arg): arg is string => typeof arg === 'string');
    if (typeof patch.cwd === 'string') entry.cwd = patch.cwd;
    if (typeof patch.url === 'string') entry.url = patch.url.trim();
    if (typeof patch.transport === 'string') entry.type = patch.transport;
    if (patch.env !== undefined) entry.env = mergeSecrets(entry.env, patch.env);
    if (patch.headers !== undefined) entry.headers = mergeSecrets(entry.headers, patch.headers);

    const transport = transportOf(entry);
    const validated = validateServerInput({
      name,
      transport,
      ...(entry.command === undefined ? {} : { command: entry.command }),
      ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      ...(entry.env === undefined ? {} : { env: entry.env }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    });
    if ('error' in validated) throw new Error(validated.error);

    const nextEntry: McpServerEntry = { ...entry, type: transport };
    if (validated.value.command !== undefined) nextEntry.command = validated.value.command;
    if (validated.value.args !== undefined) nextEntry.args = validated.value.args;
    file.mcpServers[name] = nextEntry;
    await this.write(scope, resolvedProject, file);

    // Re-read so the returned view is what actually landed on disk.
    const reread = await this.read(scope, resolvedProject);
    if (!reread.mcpServers[name]) throw new Error('The MCP config write did not persist.');
    if ('pin' in patch) await this.recordPin(reread.mcpServers[name]);
    return this.view(name, reread.mcpServers[name], scope, await this.allLedgerEntries());
  }

  async remove(scope: McpScope, name: string, projectPath?: string): Promise<void> {
    const resolvedProject = scope === 'project' ? this.requireProject(projectPath) : undefined;
    const file = await this.read(scope, resolvedProject);
    if (!file.mcpServers[name]) throw new Error('MCP server was not found.');
    const args = ['mcp', 'remove', name, ...(scope === 'project' ? ['--project'] : [])];
    const result = await this.runCli(args, { ...(resolvedProject ? { cwd: resolvedProject } : {}) });
    if (result.code !== 0) throw new Error(`gjc mcp remove failed with exit ${result.code}.`);
    const reread = await this.read(scope, resolvedProject);
    if (reread.mcpServers[name]) throw new Error('gjc mcp remove reported success but the server is still in mcp.json.');
  }

  async verify(scope: McpScope, name: string, projectPath?: string): Promise<VerifyResult> {
    const file = await this.read(scope, scope === 'project' ? this.requireProject(projectPath) : undefined);
    const entry = file.mcpServers[name];
    if (!entry) throw new Error('MCP server was not found.');
    const transport = transportOf(entry);
    return transport === 'stdio'
      ? verifyStdio(entry, this.verifyTimeoutMs)
      : verifyHttp(entry, this.verifyTimeoutMs);
  }

  async pin(scope: McpScope, name: string, version: unknown, projectPath?: string): Promise<McpServerView> {
    const resolvedProject = scope === 'project' ? this.requireProject(projectPath) : undefined;
    const file = await this.read(scope, resolvedProject);
    const entry = file.mcpServers[name];
    if (!entry) throw new Error('MCP server was not found.');
    const pkg = transportOf(entry) === 'stdio' ? packageNameFromEntry(entry) : null;
    if (!pkg) throw new Error('This server has no package version to pin.');

    const currentLedger = await readLedger(this.ledgerFile());
    const bucket = pkg.manager === 'npm' ? currentLedger.packages.npm : currentLedger.packages.pip;
    const current = bucket[pkg.name]?.version ?? null;
    const normalized = normalizePin(version);
    // An explicit older version is a pin by definition; normalizePin already
    // keeps exactly that version, and isDowngrade documents the intent.
    if (normalized && isDowngrade(current, normalized)) {
      console.log(`[mcp] ${name}: pinning ${pkg.name} at ${normalized} (older than installed ${current}).`);
    }
    entry.pin = normalized;
    file.mcpServers[name] = entry;
    await this.write(scope, resolvedProject, file);
    const reread = await this.read(scope, resolvedProject);
    if (!reread.mcpServers[name]) throw new Error('The MCP config write did not persist.');
    await this.recordPin(reread.mcpServers[name]);
    return this.view(name, reread.mcpServers[name], scope, await this.allLedgerEntries());
  }

  private async recordPin(entry: McpServerEntry): Promise<void> {
    const pkg = transportOf(entry) === 'stdio' ? packageNameFromEntry(entry) : null;
    if (!pkg) return;
    const ledger = await readLedger(this.ledgerFile());
    const bucket = pkg.manager === 'npm' ? ledger.packages.npm : ledger.packages.pip;
    const current = bucket[pkg.name];
    if (!current) return;
    if (entry.pin) current.pin = entry.pin;
    else delete current.pin;
    await writeLedger(this.ledgerFile(), ledger);
  }

  async catalog(query: { q?: string; source?: string; cursor?: string; limit?: number; sort?: CatalogSort } = {}): Promise<{
    entries: CatalogEntry[];
    nextCursor: string | null;
    warning?: string;
    registryError?: string;
    counts: Record<CatalogSource, number>;
  }> {
    const overlay = await loadOverlay({
      ...(this.env.MCP_CATALOG_URL ? { url: this.env.MCP_CATALOG_URL } : {}),
      cacheFile: this.options.catalogCachePath ?? path.join(path.dirname(agentDir(this.env)), 'app', 'mcp-catalog-cache.json'),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const q = query.q?.trim() ?? '';
    let registryEntries: CatalogEntry[] = [];
    let nextCursor: string | null = null;
    let registryError: string | undefined;
    const wantsRegistry = query.source !== 'bundled' && query.source !== 'overlay';
    if (wantsRegistry && q.length >= 3) {
      try {
        const result = await this.registry().search({
          search: q,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        });
        registryEntries = result.entries;
        nextCursor = result.nextCursor;
      } catch (error) {
        registryError = messageOf(error, 'The MCP registry is unavailable.');
      }
    }
    const merged = mergeCatalog(bundledCatalog(), overlay.entries, registryEntries);
    const counts: Record<CatalogSource, number> = { bundled: 0, overlay: 0, registry: 0 };
    for (const entry of merged) counts[entry.source] += 1;
    let entries = q ? searchCatalog(merged, q) : [...merged];
    if (query.source === 'bundled' || query.source === 'overlay' || query.source === 'registry') {
      entries = entries.filter((entry) => entry.source === query.source);
    }
    // Popularity is a ranking input, but the lookup is bounded and cached; a
    // failure leaves the entry without a number instead of failing the list.
    entries = await attachGitHubStars(entries, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.env.GITHUB_TOKEN ? { token: this.env.GITHUB_TOKEN } : {}),
    });
    // A query narrows the list; the requested order still decides what is left,
    // so typing never silently overrides the sort the user picked. With no sort
    // and no query the browse default is alphabetical, and with a query it is
    // the match ranking.
    if (q) entries = searchCatalog(entries, q);
    if (query.sort === 'popularity') {
      // Deliberately ignores provenance: a starred marketplace server can
      // outrank a curated one, which is the point of this option.
      entries = [...entries].sort((a, b) => (
        (b.stars ?? 0) - (a.stars ?? 0)
        || (b.popularity ?? 0) - (a.popularity ?? 0)
        || a.name.localeCompare(b.name)
      ));
    } else if (query.sort === 'relevance') {
      // Browse has no match tiers: every entry ties, so provenance and quality
      // decide. Reuse the search comparator rather than growing a second one.
      if (!q) entries = rankCatalog(entries.map((entry) => ({ entry, tier: 0 })));
    } else if (query.sort === 'name' || !q) {
      entries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      entries,
      nextCursor,
      counts,
      ...(overlay.warning ? { warning: overlay.warning } : {}),
      ...(registryError ? { registryError } : {}),
    };
  }

  async status(projectPath?: string): Promise<{
    provisioning: Awaited<ReturnType<typeof readProvisionState>>;
    inFlight: boolean;
    failed: ReturnType<typeof failedEntries>;
    ledger: Awaited<ReturnType<typeof readLedger>>['packages'];
    missingMounts: Array<{ server: string; path: string; purpose?: string; composeLine: string }>;
    generatedAt: string;
  }> {
    const [ledger, provisioning, servers] = await Promise.all([
      readLedger(this.ledgerFile()),
      readProvisionState(this.stateFile()),
      this.list('all', projectPath),
    ]);
    const catalog = new Map(bundledCatalog().map((entry) => [entry.name, entry]));
    const missingMounts: Array<{ server: string; path: string; purpose?: string; composeLine: string }> = [];
    for (const server of servers) {
      const entry = catalog.get(server.name);
      for (const mount of entry?.requires?.mounts ?? []) {
        if (existsSync(mount.path)) continue;
        missingMounts.push({
          server: server.name,
          path: mount.path,
          ...(mount.purpose ? { purpose: mount.purpose } : {}),
          composeLine: composeLineFor(server.name, mount.path),
        });
      }
    }
    return {
      provisioning,
      inFlight: provisioning?.running === true,
      failed: failedEntries(ledger),
      ledger: ledger.packages,
      missingMounts,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const mcpService = new McpService();
