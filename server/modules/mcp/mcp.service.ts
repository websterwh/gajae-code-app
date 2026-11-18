import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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
  type InstallManager,
  type Ledger,
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
import { isDowngrade, normalizePin, parsePackageSpec } from './pins.js';
import { tailLines } from './provision.js';
import { provisionStateIsLive, provisionStatePath, readProvisionState } from './provision-state.js';
import { createRegistryClient, type RegistryClient } from './registry-client.js';

export type McpCliRunner = (
  args: string[],
  options: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `npm view --json` prints the version as a JSON string; older npm prints it bare. */
function parseNpmVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return /^v?(\S+)$/u.exec(text)?.[1] ?? null;
  }
}

/** The ledger keyed by package name (and by the binary tail), with the manager that recorded it. */
type LedgerIndex = Record<string, { manager: InstallManager; entry: LedgerEntry; name: string }>;

/**
 * npm is applied last: its bin directory leads PATH, so it is the binary a
 * shell finds. Each package is also keyed by its unscoped tail, because the
 * linked binary is named after the console script rather than the package:
 * `command: /root/.gjc/app/bin/oc-mcp` has to find the package that owns it.
 */
function indexLedger(ledger: Ledger): LedgerIndex {
  const index: LedgerIndex = {};
  for (const manager of ['uv', 'pip', 'aqua', 'npm'] as const) {
    for (const [name, entry] of Object.entries(ledger.packages[manager])) {
      index[name] = { manager, entry, name };
      const tail = name.split('/').filter(Boolean).pop();
      if (tail && tail !== name && !index[tail]) index[tail] = { manager, entry, name };
    }
  }
  return index;
}

/**
 * Packages the image owns rather than the catalog.
 *
 * MemPalace is a built-in memory provider now, so it is no longer an MCP store
 * entry, but an mcp.json row written by the memory tab still runs its binary
 * and has to keep naming the package for the version and pin controls.
 */
const BUILTIN_PACKAGES: Record<string, { manager: InstallManager; name: string }> = {
  mempalace: { manager: 'uv', name: 'mempalace' },
};

/** A pin addresses a package version; an aqua release is a tag, not one. */
function pinnableManager(manager: InstallManager): boolean {
  return manager === 'npm' || manager === 'uv' || manager === 'pip' || manager === 'apt';
}

/**
 * The package that owns a linked binary, read from where the link points.
 *
 * `uv tool install` links `<bin>/oc-mcp` into `<tools>/<package>/bin/oc-mcp`, and
 * a global npm install links into `.../lib/node_modules/<package>/bin/...`, so
 * the resolved path names the package even when the console script does not.
 */
function owningPackageName(command: string): string | null {
  if (!path.isAbsolute(command)) return null;
  let resolved = command;
  try {
    // A bin entry is a symlink; the target is what carries the package name.
    resolved = realpathSync(command);
  } catch {
    // Not linked or not on this filesystem: the path as written is all there is.
  }
  const segments = resolved.split(path.sep).filter(Boolean);
  const modules = segments.lastIndexOf('node_modules');
  if (modules >= 0) {
    const rest = segments.slice(modules + 1);
    const head = rest[0];
    if (head?.startsWith('@') && rest[1]) return `${head}/${rest[1]}`;
    return head ?? null;
  }
  const bin = segments.lastIndexOf('bin');
  if (bin >= 2) {
    const candidate = segments[bin - 1];
    if (candidate && candidate !== 'bin' && candidate !== path.basename(command)) return candidate;
  }
  return null;
}

function spawnCommand(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export type McpServerView = PublicMcpServer & {
  install: LedgerEntry | null;
  /** Which registry `packageName` belongs to; absent for a non-package install. */
  packageManager?: 'npm' | 'pypi' | null;
  /** What the package resolves to when this app never installed it. */
  availableVersion?: string | null;
};
export type VerifyResult = { ok: boolean; toolCount?: number; tools?: string[]; error?: string };
export type CatalogSort = 'name' | 'relevance' | 'popularity';

export type McpCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type McpServiceOptions = {
  agentDir?: string;
  runCli?: McpCliRunner;
  runCommand?: McpCommandRunner;
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
  private readonly versionCache = new Map<string, { version: string | null; at: number }>();

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

  /**
   * A server running `npx -y pkg@latest` from someone else's config has no
   * ledger entry, so its row showed no version and nothing could be pinned.
   * Ask npm what that spec resolves to now; the answer is cached, since every
   * list call would otherwise pay for it again.
   */
  private async resolveVersion(server: McpServerView): Promise<string | null> {
    const name = server.packageName;
    const manager = server.packageManager ?? null;
    if (!name || !manager) return null;
    const key = `${manager}:${name}`;
    const cached = this.versionCache.get(key);
    const at = Date.now();
    if (cached && at - cached.at < 10 * 60_000) return cached.version;
    let version: string | null = null;
    // The registry is asked over HTTP: a spawned `npm view` depends on the
    // server process having npm on PATH and its registry config intact, and an
    // answer of "no version" there was indistinguishable from "not installed".
    try {
      version = await this.registry().latestVersion(manager, name);
    } catch {
      version = null;
    }
    if (!version && manager === 'npm') {
      try {
        const result = await (this.options.runCommand ?? spawnCommand)('npm', ['view', name, 'version', '--json']);
        if (result.code === 0) version = parseNpmVersion(result.stdout);
      } catch {
        version = null;
      }
    }
    this.versionCache.set(key, { version, at });
    return version;
  }

  /**
   * The package a stdio server runs.
   *
   * A config can point at the binary the installer linked instead of the
   * launcher: `command: /root/.gjc/app/bin/mempalace-mcp` rather than
   * `uvx --from mempalace mempalace-mcp`. That argv carries no package name, so
   * the row printed the filesystem path and offered no version or pin even
   * though the package was installed and on PATH. The ledger knows it, so a
   * binary named after a ledger entry, or a catalog entry carrying this
   * server's name, identifies the package.
   */
  private packageFor(name: string, entry: McpServerEntry, ledger: LedgerIndex): { manager: InstallManager; name: string } | null {
    if (transportOf(entry) !== 'stdio') return null;
    const direct = packageNameFromEntry(entry);
    if (direct) {
      const known = ledger[direct.name];
      return { manager: known?.manager ?? (direct.manager === 'npm' ? 'npm' : 'uv'), name: known?.name ?? direct.name };
    }
    const command = String(entry.command ?? '').trim();
    const executable = path.basename(command);
    if (!executable) return null;
    const byBinary = ledger[executable];
    if (byBinary) return { manager: byBinary.manager, name: byBinary.name };
    // The console script can differ from its package (`oc-mcp` inside
    // `opencode-mcp`), so ask the link target which package owns it.
    const owner = owningPackageName(command);
    const owned = owner ? ledger[owner] : undefined;
    if (owned) return { manager: owned.manager, name: owned.name };
    const builtin = BUILTIN_PACKAGES[name] ?? BUILTIN_PACKAGES[executable.replace(/-mcp$/u, '')];
    if (builtin) return builtin;
    const packaged = bundledCatalog().find((candidate) => candidate.name === name)?.package;
    if (!packaged || packaged.manager === 'other') return null;
    const spec = parsePackageSpec(packaged.name).name;
    const known = ledger[spec];
    // A catalog package with no ledger entry still names the package, which is
    // what lets a config written elsewhere resolve a version and pin at all.
    return {
      manager: known?.manager ?? (packaged.manager === 'npm' ? 'npm' : 'uv'),
      name: known?.name ?? spec,
    };
  }

  private view(
    name: string,
    entry: McpServerEntry,
    scope: McpScope,
    ledger: LedgerIndex,
    disabledServers: ReadonlySet<string> = new Set(),
  ): McpServerView {
    const pkg = this.packageFor(name, entry, ledger);
    const install = pkg ? ledger[pkg.name]?.entry ?? null : null;
    const server: McpServerView = { ...publicServer(name, entry, scope, disabledServers), install };
    // publicServer reads the package from the command alone; one recovered from
    // the ledger or the catalog is what gives a binary-path entry its version
    // chip. Only a package has a pinnable version, so an aqua release reports
    // its recorded version while staying unpinnable.
    if (pkg) {
      server.packageName = pkg.name;
      server.packageManager = pkg.manager === 'npm' ? 'npm' : pkg.manager === 'aqua' ? null : 'pypi';
      server.pinnable = pinnableManager(pkg.manager);
    }
    return server;
  }

  private async allLedgerEntries(): Promise<LedgerIndex> {
    return indexLedger(await readLedger(this.ledgerFile()));
  }

  async list(scope: McpScope | 'all' = 'global', projectPath?: string): Promise<McpServerView[]> {
    const entries = await this.allLedgerEntries();
    const scopes: McpScope[] = scope === 'all'
      ? ['global', ...(projectPath ? ['project' as const] : [])]
      : [scope];
    const servers: McpServerView[] = [];
    for (const current of scopes) {
      const file = await this.read(current, current === 'project' ? this.requireProject(projectPath) : undefined);
      const disabled = new Set(file.disabledServers ?? []);
      for (const [name, entry] of Object.entries(file.mcpServers)) {
        servers.push(this.view(name, entry, current, entries, disabled));
      }
    }
    const sorted = servers.sort((a, b) => a.name.localeCompare(b.name));
    // The ledger is the truth for anything this app installed; the registry is
    // only asked about servers that were configured somewhere else.
    await Promise.all(sorted.map(async (server) => {
      if (server.install?.version || !server.pinnable) return;
      server.availableVersion = await this.resolveVersion(server);
    }));
    return sorted;
  }

  async get(scope: McpScope, name: string, projectPath?: string): Promise<McpServerView | null> {
    const file = await this.read(scope, scope === 'project' ? this.requireProject(projectPath) : undefined);
    const entry = file.mcpServers[name];
    return entry
      ? this.view(name, entry, scope, await this.allLedgerEntries(), new Set(file.disabledServers ?? []))
      : null;
  }

  async add(input: unknown): Promise<McpServerView> {
    const validated = validateServerInput(input);
    if ('error' in validated) throw new Error(validated.error);
    const value = validated.value;
    const scope = value.scope ?? 'global';
    const projectPath = scope === 'project' ? this.requireProject(value.projectPath) : undefined;
    const file = await this.read(scope, projectPath);
    if (file.mcpServers[value.name]) throw new Error(`A server named "${value.name}" already exists.`);

    // Values travel inline as --flag=value. Space-separated, a value that
    // starts with a dash (`--arg -y`) is parsed as another flag, and gjc exits
    // 2 without writing anything - every catalog server starts `npx -y ...`,
    // so every install from the page failed that way.
    const args = ['mcp', 'add', value.name, `--type=${value.transport}`];
    if (value.command) args.push(`--command=${value.command}`);
    for (const arg of value.args ?? []) args.push(`--arg=${arg}`);
    for (const [key, envValue] of Object.entries(value.env ?? {})) args.push(`--env=${key}=${envValue}`);
    if (value.url) args.push(`--url=${value.url}`);
    // gjc accepts header values as KEY=VALUE; a colon is rejected as invalid.
    for (const [key, headerValue] of Object.entries(value.headers ?? {})) args.push(`--header=${key}=${headerValue}`);
    if (scope === 'project') args.push('--project');

    const result = await this.runCli(args, { ...(projectPath ? { cwd: projectPath } : {}) });
    if (result.code !== 0) {
      // The CLI's own usage text is the only thing that explains a rejected
      // argument, so it belongs in the message instead of a bare exit code.
      const detail = tailLines(result.stderr || result.stdout, 3);
      throw new Error(`gjc mcp add failed with exit ${result.code}.${detail ? ` ${detail}` : ''}`);
    }
    const written = await this.read(scope, projectPath);
    const entry = written.mcpServers[value.name];
    if (!entry) throw new Error('gjc mcp add reported success but the server is not in mcp.json.');
    return this.view(value.name, entry, scope, await this.allLedgerEntries(), new Set(written.disabledServers ?? []));
  }

  async update(scope: McpScope, name: string, patch: Record<string, unknown>, projectPath?: string): Promise<McpServerView> {
    const resolvedProject = scope === 'project' ? this.requireProject(projectPath) : undefined;
    const file = await this.read(scope, resolvedProject);
    const entry = file.mcpServers[name];
    if (!entry) throw new Error('MCP server was not found.');

    if (typeof patch.enabled === 'boolean') {
      // The runtime reads `enabled`, and a name in `disabledServers` blocks the
      // server independently. Older builds wrote a non-standard `disabled`
      // field that nothing reads, which is why the toggle appeared to do
      // nothing; drop it and write the field the agent actually honors.
      entry.enabled = patch.enabled;
      delete entry.disabled;
      if (file.disabledServers) {
        file.disabledServers = file.disabledServers.filter((serverName) => serverName !== name);
        if (!file.disabledServers.length) delete file.disabledServers;
      }
    }
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
    if ('pin' in patch) await this.recordPin(name, reread.mcpServers[name]);
    return this.view(name, reread.mcpServers[name], scope, await this.allLedgerEntries(), new Set(reread.disabledServers ?? []));
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

  /**
   * Moves a server between the global config and one project's config.
   *
   * Scope used to be decided at install time and could not be changed, which
   * left two ways to "move" a server and both of them broken: adding it again
   * in the other scope failed with "already exists", and the scope select on
   * the page only filtered the list. The entry is copied with every runtime
   * key intact, then removed from the source, so a name lives in one place.
   */
  async move(
    scope: McpScope,
    name: string,
    targetScope: McpScope,
    projectPath?: string,
    targetProjectPath?: string,
  ): Promise<McpServerView> {
    const sourceProject = scope === 'project' ? this.requireProject(projectPath) : undefined;
    const targetProject = targetScope === 'project' ? this.requireProject(targetProjectPath) : undefined;
    if (scope === targetScope && sourceProject === targetProject) {
      const current = await this.get(scope, name, sourceProject);
      if (!current) throw new Error('MCP server was not found.');
      return current;
    }

    const sourceFile = await this.read(scope, sourceProject);
    const entry = sourceFile.mcpServers[name];
    if (!entry) throw new Error('MCP server was not found.');
    const targetFile = await this.read(targetScope, targetProject);
    if (targetFile.mcpServers[name]) throw new Error(`A server named "${name}" already exists.`);

    targetFile.mcpServers[name] = { ...entry };
    // A denylisted name has to stay denied where it lands, or the move would
    // switch on a server that was stored as off.
    const denylisted = (sourceFile.disabledServers ?? []).includes(name);
    if (denylisted) {
      targetFile.disabledServers = [...new Set([...(targetFile.disabledServers ?? []), name])];
    }
    await this.write(targetScope, targetProject, targetFile);

    delete sourceFile.mcpServers[name];
    if (denylisted) {
      sourceFile.disabledServers = (sourceFile.disabledServers ?? []).filter((server) => server !== name);
    }
    await this.write(scope, sourceProject, sourceFile);

    return this.view(
      name,
      entry,
      targetScope,
      await this.allLedgerEntries(),
      new Set(targetFile.disabledServers ?? []),
    );
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
    if (!entry) throw new Error('MCP server was not found.');    const currentLedger = await readLedger(this.ledgerFile());
    const index = indexLedger(currentLedger);
    const pkg = this.packageFor(name, entry, index);
    if (!pkg) throw new Error('This server has no package version to pin.');
    if (!pinnableManager(pkg.manager)) throw new Error('This server is installed from a release, not a package, so it has no version to pin.');

    // Read the entry the installer recorded: a uv tool is a pypi package, so a
    // bucket chosen from the manager name would miss its uv entry.
    const current = index[pkg.name]?.entry.version ?? null;
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
    await this.recordPin(name, reread.mcpServers[name]);
    return this.view(name, reread.mcpServers[name], scope, await this.allLedgerEntries(), new Set(reread.disabledServers ?? []));
  }

  private async recordPin(name: string, entry: McpServerEntry): Promise<void> {
    const ledger = await readLedger(this.ledgerFile());
    const index = indexLedger(ledger);
    const pkg = this.packageFor(name, entry, index);
    if (!pkg) return;
    const current = index[pkg.name]?.entry;
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
      inFlight: provisionStateIsLive(provisioning),
      failed: failedEntries(ledger),
      ledger: ledger.packages,
      missingMounts,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const mcpService = new McpService();
