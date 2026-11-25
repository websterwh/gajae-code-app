import { readFile } from 'node:fs/promises';

import { desiredPackagesPath, readDesired, upsertDesired, writeDesired } from './desired.js';
import { ledgerFilePath, readLedger, recordInstalled, writeLedger } from './ledger.js';
import { parsePackageSpec } from './pins.js';
import { parseInstalledVersion, spawnCommandRunner, verifyCommand, type CommandRunner } from './provision.js';

/**
 * Packages an agent installed while working. `apt install` and `pip install`
 * talk to the container's writable layer, which is recreated from the image,
 * so the package is gone on the next start. The app already has a provisioning
 * ledger that reinstalls everything it knows about on boot; this module turns
 * the agent's own successful installs into ledger and desired entries, so the
 * same packages come back without the user retyping them in Settings.
 */
export type AgentPackageManager = 'apt' | 'pip' | 'npm' | 'uv';
export type AgentPackageInstall = { manager: AgentPackageManager; name: string; spec: string };

const MAX_PACKAGE_TOKENS = 40;
const SAFE_TOKEN = /^[A-Za-z0-9@][A-Za-z0-9._+@/:=-]*$/u;

/** Splits a shell command line on unquoted operators, keeping quoted text whole. */
export function splitShellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  const finishToken = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"' && index + 1 < command.length) token += command[(index += 1)];
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      token += command[(index += 1)];
      started = true;
      continue;
    }
    if (character === '#' && !started) break;
    if (character === '\n' || character === ';' || character === '|' || character === '&') {
      // `||` and `&&` are two characters of the same operator.
      if ((character === '|' || character === '&') && command[index + 1] === character) index += 1;
      finishSegment();
      continue;
    }
    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    token += character;
    started = true;
  }
  finishSegment();
  return segments;
}

const COMMAND_PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'exec', 'nohup']);

const isFlag = (token: string): boolean => token.startsWith('-');

const acceptableSpec = (token: string): boolean => SAFE_TOKEN.test(token)
  && !token.startsWith('.')
  && !token.includes('$')
  && !token.includes('://')
  && !token.startsWith('git+')
  && !token.includes('#')
  && !token.endsWith('.whl')
  && !token.endsWith('.deb')
  && !token.endsWith('.tgz');

function packageSpecs(tokens: readonly string[], start: number): string[] {
  const specs: string[] = [];
  for (const token of tokens.slice(start)) {
    if (isFlag(token) || token === '\\') continue;
    if (!acceptableSpec(token)) continue;
    specs.push(token);
    if (specs.length >= MAX_PACKAGE_TOKENS) break;
  }
  return specs;
}

function indexOfCommand(tokens: readonly string[]): { base: string; rest: string[] } {
  let index = 0;
  while (index < tokens.length) {
    const base = tokens[index].split('/').pop() ?? tokens[index];
    if (COMMAND_PREFIXES.has(base) || /^[A-Z_][A-Z0-9_]*=/u.test(tokens[index])) {
      index += 1;
      continue;
    }
    return { base, rest: tokens.slice(index) };
  }
  return { base: '', rest: [] };
}

/**
 * Every install an agent asked for, in order. Only the shapes whose meaning is
 * unambiguous are read: an install whose package list comes from a file
 * (`-r requirements.txt`), a URL, or a local checkout cannot be replayed from
 * the command alone and is left to the user.
 */
export function parseInstallCommands(commands: readonly string[]): AgentPackageInstall[] {
  const found: AgentPackageInstall[] = [];
  const seen = new Set<string>();
  const add = (manager: AgentPackageManager, specs: readonly string[]) => {
    for (const spec of specs) {
      const name = parsePackageSpec(spec).name;
      if (!name) continue;
      const key = `${manager}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ manager, name, spec });
    }
  };
  for (const command of commands) {
    for (const tokens of splitShellSegments(command)) {
      const { base, rest } = indexOfCommand(tokens);
      if (!rest.length) continue;
      const args = rest.slice(1);
      if (base === 'apt' || base === 'apt-get') {
        const install = args.indexOf('install');
        if (install >= 0) add('apt', packageSpecs(args, install + 1));
        continue;
      }
      if (base === 'pip' || base === 'pip3' || (base === 'python' || base === 'python3') && args[0] === '-m' && args[1] === 'pip') {
        const offset = base === 'pip' || base === 'pip3' ? 0 : 2;
        const install = args.indexOf('install', offset);
        if (install < 0) continue;
        if (args.some((token) => token === '-r' || token === '--requirement' || token === '-e' || token === '--editable')) continue;
        add('pip', packageSpecs(args, install + 1));
        continue;
      }
      if (base === 'uv') {
        const install = args.indexOf('install');
        if (install < 0) continue;
        if (args.slice(0, install).includes('pip')) { add('pip', packageSpecs(args, install + 1)); continue; }
        if (args.slice(0, install).includes('tool')) add('uv', packageSpecs(args, install + 1));
        continue;
      }
      if (base === 'npm' && (args.includes('install') || args.includes('i'))) {
        if (!args.includes('-g') && !args.includes('--global')) continue;
        const install = args.includes('install') ? args.indexOf('install') : args.indexOf('i');
        add('npm', packageSpecs(args, install + 1));
      }
    }
  }
  return found;
}

/** Bash commands from a GJC transcript, in the order the model issued them. */
export function installCommandsFromTranscript(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const toolCall = part as { type?: unknown; name?: unknown; arguments?: unknown };
      if (toolCall.type !== 'toolCall' || toolCall.name !== 'bash') continue;
      const raw = typeof toolCall.arguments === 'string'
        ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return null; } })()
        : toolCall.arguments;
      const command = (raw as { command?: unknown } | null)?.command;
      if (typeof command === 'string' && command.trim()) commands.push(command);
    }
  }
  return commands;
}

export type AdoptAgentPackagesOptions = {
  desiredFile?: string;
  ledgerFile?: string;
  runner?: CommandRunner;
  now?: () => string;
  /** Tests can answer installation directly instead of running a package manager. */
  verify?: (install: AgentPackageInstall) => Promise<{ installed: boolean; version: string | null }>;
};

async function defaultVerify(install: AgentPackageInstall, runner: CommandRunner): Promise<{ installed: boolean; version: string | null }> {
  const command = verifyCommand(install.manager, install.name);
  const result = await runner(command.command, command.args);
  if (result.code !== 0) return { installed: false, version: null };
  return { installed: true, version: parseInstalledVersion(install.manager, install.name, result.stdout) };
}

/**
 * Records installs that are actually present. A command the agent wrote but
 * that failed (or that installed into a virtualenv the app's manager does not
 * own) must not become a boot-time install, so each one is verified first.
 */
export async function adoptAgentPackageInstalls(
  installs: readonly AgentPackageInstall[],
  options: AdoptAgentPackagesOptions = {},
): Promise<AgentPackageInstall[]> {
  if (installs.length === 0) return [];
  const desiredFile = options.desiredFile ?? desiredPackagesPath();
  const ledgerFile = options.ledgerFile ?? ledgerFilePath();
  const runner = options.runner ?? spawnCommandRunner();
  const now = options.now ?? (() => new Date().toISOString());
  const desired = await readDesired(desiredFile);
  const ledger = await readLedger(ledgerFile);
  const adopted: AgentPackageInstall[] = [];
  for (const install of installs) {
    // Already wanted and confirmed installed: nothing to write, and no reason
    // to run a package manager's verifier on every later turn.
    if (desired.packages[install.manager][install.name] && ledger.packages[install.manager][install.name]?.status === 'installed') continue;
    const check = options.verify
      ? await options.verify(install)
      : await defaultVerify(install, runner).catch(() => ({ installed: false, version: null }));
    if (!check.installed) continue;
    upsertDesired(desired, {
      manager: install.manager,
      name: install.name,
      spec: install.spec,
      pin: null,
      addedAt: now(),
    });
    recordInstalled(ledger, install.manager, install.name, {
      spec: install.spec,
      version: check.version,
      at: now(),
    });
    adopted.push(install);
  }
  if (adopted.length > 0) {
    await writeDesired(desiredFile, desired);
    await writeLedger(ledgerFile, ledger);
  }
  return adopted;
}

/** The post-turn entry point: read one transcript and adopt what it installed. */
export async function adoptAgentInstalledPackagesFromTranscript(
  transcriptPath: string,
  options: AdoptAgentPackagesOptions = {},
): Promise<AgentPackageInstall[]> {
  const text = await readFile(transcriptPath, 'utf8').catch(() => '');
  if (!text) return [];
  return adoptAgentPackageInstalls(parseInstallCommands(installCommandsFromTranscript(text)), options);
}
