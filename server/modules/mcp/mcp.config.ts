import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { isPinnableTransport, parsePackageSpec } from './pins.js';

export const REDACTED = '${REDACTED}';
export const MCP_SCOPES = ['global', 'project'] as const;
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;

export type McpScope = (typeof MCP_SCOPES)[number];
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type McpServerEntry = {
  type?: string;
  /** The runtime's own switch: `false` keeps the server stored but unloaded. */
  enabled?: boolean;
  autoload?: boolean;
  timeout?: number;
  sharing?: string;
  protocol?: string;
  noInheritEnv?: boolean;
  auth?: Record<string, unknown>;
  oauth?: Record<string, unknown>;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Written by builds before the switch used `enabled`; read only. */
  disabled?: boolean;
  pin?: string | null;
};

export type McpFile = {
  mcpServers: Record<string, McpServerEntry>;
  /** The runtime's other denylist; a name here is not loaded. */
  disabledServers?: string[];
};

export type PublicMcpServer = {
  name: string;
  transport: McpTransport;
  scope: McpScope;
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env: Record<string, string>;
  envIsSet: Record<string, boolean>;
  headers: Record<string, string>;
  headersIsSet: Record<string, boolean>;
  pin: string | null;
  pinnable: boolean;
  packageName: string | null;
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
}

/** `<cwd>/.gjc/mcp.json` for project scope; the agent's own file otherwise. */
export function mcpConfigPath(scope: McpScope, projectPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (scope === 'project') {
    if (!projectPath) throw new Error('A project path is required for project scope.');
    return path.join(path.resolve(projectPath), '.gjc', 'mcp.json');
  }
  return path.join(agentDir(env), 'mcp.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function normalizeEntry(value: unknown): McpServerEntry | null {
  if (!isRecord(value)) return null;
  const entry: McpServerEntry = {};
  if (typeof value.type === 'string') entry.type = value.type;
  if (typeof value.enabled === 'boolean') entry.enabled = value.enabled;
  if (typeof value.autoload === 'boolean') entry.autoload = value.autoload;
  if (typeof value.timeout === 'number' && Number.isFinite(value.timeout)) entry.timeout = value.timeout;
  if (typeof value.sharing === 'string') entry.sharing = value.sharing;
  if (typeof value.protocol === 'string') entry.protocol = value.protocol;
  if (typeof value.noInheritEnv === 'boolean') entry.noInheritEnv = value.noInheritEnv;
  if (isRecord(value.auth)) entry.auth = value.auth;
  if (isRecord(value.oauth)) entry.oauth = value.oauth;
  if (typeof value.command === 'string') entry.command = value.command;
  if (Array.isArray(value.args)) entry.args = value.args.filter((arg): arg is string => typeof arg === 'string');
  if (typeof value.cwd === 'string') entry.cwd = value.cwd;
  if (typeof value.url === 'string') entry.url = value.url;
  if (typeof value.disabled === 'boolean') entry.disabled = value.disabled;
  if (typeof value.pin === 'string') entry.pin = value.pin;
  if (value.pin === null) entry.pin = null;
  const env = stringRecord(value.env);
  if (Object.keys(env).length) entry.env = env;
  const headers = stringRecord(value.headers);
  if (Object.keys(headers).length) entry.headers = headers;
  return entry;
}

export async function readMcpConfig(
  scope: McpScope,
  projectPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpFile> {
  const file = mcpConfigPath(scope, projectPath, env);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const servers = isRecord(parsed) && isRecord((parsed as { mcpServers?: unknown }).mcpServers)
      ? (parsed as { mcpServers: Record<string, unknown> }).mcpServers
      : {};
    const result: McpFile = { mcpServers: {} };
    for (const [name, entry] of Object.entries(servers)) {
      const normalized = normalizeEntry(entry);
      if (normalized) result.mcpServers[name] = normalized;
    }
    const disabledServers = Array.isArray((parsed as { disabledServers?: unknown }).disabledServers)
      ? ((parsed as { disabledServers: unknown[] }).disabledServers)
        .filter((name): name is string => typeof name === 'string')
      : [];
    // Rewriting the file must not silently wipe the runtime's denylist.
    return disabledServers.length ? { ...result, disabledServers } : result;
  } catch {
    return { mcpServers: {} };
  }
}

/** Atomic write: a half-written mcp.json would break the agent's next session. */
export async function writeMcpConfig(
  scope: McpScope,
  projectPath: string | undefined,
  file: McpFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = mcpConfigPath(scope, projectPath, env);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export function transportOf(entry: McpServerEntry): McpTransport {
  const declared = String(entry.type ?? '').toLowerCase();
  if (declared === 'http' || declared === 'sse') return declared;
  if (entry.url) return /sse/iu.test(declared) ? 'sse' : 'http';
  return 'stdio';
}

/**
 * The package a stdio server runs, when the command is a known launcher.
 *
 * `spec` is the argument as written, so a versioned or git spec installs what
 * the server actually runs. `name` is the bare package name, which is the key
 * the ledger and the pins use: `@playwright/mcp@latest` and
 * `git+https://github.com/oraios/serena` are both recorded under the bare name.
 */
export type EntryPackage = { manager: 'npm' | 'pypi'; spec: string; name: string };

export function packageSpecFromEntry(entry: McpServerEntry): EntryPackage | null {
  const command = path.basename(String(entry.command ?? '')).replace(/\.(?:cmd|exe)$/iu, '');
  const args = Array.isArray(entry.args) ? entry.args : [];
  // Only an argv token can be a package. A path is the binary the installer
  // linked, not something to install.
  const firstValue = args.find((arg) => !arg.startsWith('-'));
  if (!firstValue || path.isAbsolute(firstValue)) return null;
  const name = parsePackageSpec(firstValue).name || firstValue;
  if (command === 'npx' || command === 'npm') return { manager: 'npm', spec: firstValue, name };
  if (command === 'uvx' || command === 'uv') return { manager: 'pypi', spec: firstValue, name };
  return null;
}

export function packageNameFromEntry(entry: McpServerEntry): { manager: 'npm' | 'pypi'; name: string } | null {
  const pkg = packageSpecFromEntry(entry);
  return pkg ? { manager: pkg.manager, name: pkg.name } : null;
}

function publicValues(record: Record<string, string> | undefined): { values: Record<string, string>; isSet: Record<string, boolean> } {
  const values: Record<string, string> = {};
  const isSet: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    values[key] = String(value);
    isSet[key] = true;
  }
  return { values, isSet };
}

/**
 * Values come back as stored: the configure form is the entry mcp.json holds,
 * and a blanked-out token only asks the user for something already saved.
 * `envIsSet`/`headersIsSet` stay, since a row needs to know a value exists.
 */
export function publicServer(
  name: string,
  entry: McpServerEntry,
  scope: McpScope,
  disabledServers: ReadonlySet<string> = new Set(),
): PublicMcpServer {
  const transport = transportOf(entry);
  const pkg = transport === 'stdio' ? packageNameFromEntry(entry) : null;
  const env = publicValues(entry.env);
  const headers = publicValues(entry.headers);
  return {
    name,
    transport,
    scope,
    enabled: entry.enabled !== false && entry.disabled !== true && !disabledServers.has(name),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    env: env.values,
    envIsSet: env.isSet,
    headers: headers.values,
    headersIsSet: headers.isSet,
    pin: entry.pin ?? null,
    pinnable: isPinnableTransport(transport) && Boolean(pkg),
    packageName: pkg?.name ?? null,
  };
}

export type ServerInput = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  scope?: McpScope;
  projectPath?: string;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function isStringArray(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && entry.length <= 4096);
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function validSecretRecord(value: unknown, keyPattern: RegExp): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key, entry]) => keyPattern.test(key) && typeof entry === 'string' && entry.length <= 8192);
}

/**
 * argv arrays only: there is no shell in the spawn path, so shell
 * metacharacters are just characters in an argument. Absolute paths are
 * allowed, and names are unique.
 */
export function validateServerInput(input: unknown): { value: ServerInput } | { error: string } {
  if (!isRecord(input)) return { error: 'A server object is required.' };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME.test(name)) return { error: 'A server name must be 1-64 characters of letters, digits, dot, dash or underscore.' };
  const transport = String(input.transport ?? '').trim().toLowerCase();
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) return { error: 'transport must be stdio, http or sse.' };

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return { error: 'A stdio server needs a command.' };
    if (input.args !== undefined && !isStringArray(input.args, 64)) return { error: 'args must be an array of at most 64 strings.' };
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd))) {
      return { error: 'cwd must be an absolute path.' };
    }
    if (input.env !== undefined && !validSecretRecord(input.env, ENV_KEY)) {
      return { error: 'env must be an object of at most 32 NAME=value strings.' };
    }
    return {
      value: {
        name,
        transport: 'stdio',
        command,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.scope === 'global' || input.scope === 'project' ? { scope: input.scope } : {}),
        ...(typeof input.projectPath === 'string' ? { projectPath: input.projectPath } : {}),
      },
    };
  }

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url || !validHttpUrl(url)) return { error: 'url must be an http(s) or ws(s) URL.' };
  if (input.headers !== undefined && !validSecretRecord(input.headers, /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u)) {
    return { error: 'headers must be an object of at most 32 strings.' };
  }
  return {
    value: {
      name,
      transport: transport as 'http' | 'sse',
      url,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.scope === 'global' || input.scope === 'project' ? { scope: input.scope } : {}),
      ...(typeof input.projectPath === 'string' ? { projectPath: input.projectPath } : {}),
    },
  };
}
