import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { agentDir } from '../mcp/index.js';

/**
 * `config.yml` is the CLI's file, so the app edits only the top-level blocks it
 * owns — `memory` and `hindsight` — and leaves every other byte alone. The same
 * rule as `gjc-notifications.config.ts`: a rewrite is refused unless the result
 * reads back as exactly the tree that was intended.
 */

export type MemoryBackend = 'off' | 'local' | 'hindsight';
export type MemoryProvider = MemoryBackend | 'mempalace';

export type YamlScalar = string | number | boolean | null;
export type YamlBlock = { [key: string]: YamlScalar | string[] };

export type MemoryProviderMarker = { provider: MemoryProvider };

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_STRING = /^[A-Za-z_][A-Za-z0-9_./-]*$/;

export function memoryConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), 'config.yml');
}

export function memoryProviderMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), 'memory-provider.json');
}

const isIgnorable = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
};

const parseScalar = (raw: string): YamlScalar => {
  const value = raw.trim();
  if (value === '' || value === '~' || value.toLowerCase() === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return unquote(value);
};

const splitLines = (text: string): string[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
};

function blockRange(lines: string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => new RegExp(`^${name}:\\s*(?:#.*)?$`).test(line));
  if (start === -1) return null;
  let last = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isIgnorable(lines[index])) continue;
    if (indentOf(lines[index]) === 0) break;
    last = index;
  }
  return { start, end: last + 1 };
}

/** Reads a top-level block made of scalars and scalar lists; nothing nested. */
function parseBlock(lines: string[], start: number, end: number): YamlBlock {
  const body = lines.slice(start + 1, end);
  const first = body.find((line) => !isIgnorable(line));
  if (first === undefined) return {};
  const indent = indentOf(first);
  const block: YamlBlock = {};
  let currentKey: string | null = null;

  for (const line of body) {
    if (isIgnorable(line)) continue;
    const trimmed = line.trim();
    if (indentOf(line) !== indent) continue;
    if (trimmed.startsWith('- ')) {
      if (!currentKey) continue;
      const existing = block[currentKey];
      if (Array.isArray(existing)) existing.push(unquote(trimmed.slice(2)) as string);
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = unquote(trimmed.slice(0, colon));
    const rest = trimmed.slice(colon + 1).trim();
    if (rest === '') {
      currentKey = key;
      block[key] = [];
      continue;
    }
    currentKey = null;
    block[key] = parseScalar(rest);
  }
  return block;
}

const quoteKey = (key: string): string => (PLAIN_KEY.test(key) ? key : `"${key.replace(/"/g, '\\"')}"`);

const formatScalar = (value: YamlScalar): string => {
  if (value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return PLAIN_STRING.test(value) && value !== 'true' && value !== 'false'
    ? value
    : `'${value.replace(/'/g, "''")}'`;
};

function emitBlock(name: string, block: YamlBlock): string[] {
  const lines = [`${name}:`];
  for (const [key, value] of Object.entries(block)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`  ${quoteKey(key)}: []`);
        continue;
      }
      lines.push(`  ${quoteKey(key)}:`);
      for (const item of value) lines.push(`    - ${formatScalar(item)}`);
      continue;
    }
    lines.push(`  ${quoteKey(key)}: ${formatScalar(value)}`);
  }
  return lines;
}

export function readMemoryBlocks(text: string): { memory: YamlBlock; hindsight: YamlBlock } {
  const lines = splitLines(text);
  const read = (name: string): YamlBlock => {
    const range = blockRange(lines, name);
    return range ? parseBlock(lines, range.start, range.end) : {};
  };
  return { memory: read('memory'), hindsight: read('hindsight') };
}

export function writeMemoryBlocks(
  text: string,
  patch: Partial<Record<'memory' | 'hindsight', YamlBlock>>,
): string {
  let lines = splitLines(text);
  for (const name of ['memory', 'hindsight'] as const) {
    const block = patch[name];
    if (!block) continue;
    const range = blockRange(lines, name);
    const emitted = emitBlock(name, block);
    lines = range
      ? [...lines.slice(0, range.start), ...emitted, ...lines.slice(range.end)]
      : [...lines, ...emitted];
  }
  const candidate = `${lines.join('\n').trimEnd()}\n`;
  const applied: Partial<Record<'memory' | 'hindsight', YamlBlock>> = {};
  for (const name of ['memory', 'hindsight'] as const) {
    if (patch[name]) applied[name] = patch[name];
  }
  const reread = readMemoryBlocks(candidate);
  for (const [name, expected] of Object.entries(applied) as Array<['memory' | 'hindsight', YamlBlock]>) {
    if (JSON.stringify(reread[name]) !== JSON.stringify(expected)) {
      throw new Error(`config.yml ${name} block would not survive a rewrite`);
    }
  }
  return candidate;
}

export async function readMemoryConfigText(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    return await readFile(memoryConfigPath(env), 'utf8');
  } catch {
    return '';
  }
}

/** Atomic write; `config.yml` is read by the agent on its next session. */
export async function writeMemoryConfigText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = memoryConfigPath(env);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, target);
}

export async function readMemoryProviderMarker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryProviderMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(memoryProviderMarkerPath(env), 'utf8')) as unknown;
    const provider = parsed && typeof parsed === 'object'
      ? (parsed as { provider?: unknown }).provider
      : undefined;
    return provider === 'off' || provider === 'local' || provider === 'hindsight' || provider === 'mempalace'
      ? { provider }
      : null;
  } catch {
    return null;
  }
}

export async function writeMemoryProviderMarker(
  provider: MemoryProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = memoryProviderMarkerPath(env);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ provider }, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function clearMemoryProviderMarker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(memoryProviderMarkerPath(env), { force: true });
}
