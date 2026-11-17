import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { agentDir } from '../mcp/index.js';

/**
 * MemPalace ships with the image: the entrypoint installs the tool and points
 * its config dir at the mounted volume, so the palace and the embedding model
 * survive a recreate. The app only has to keep the MCP entry and the autosave
 * hook in place — the palace itself is MemPalace's file format, not ours.
 */

export const MEMPALACE_SERVER = 'mempalace';
export const MEMPALACE_HOOK_PATH = ['hooks', 'post', 'mempalace-autosave.ts'] as const;

export function mempalaceBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMPALACE_BIN_DIR || path.join(env.HOME || homedir(), '.gjc', 'app', 'bin');
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (directory && existsSync(path.join(directory, name))) return true;
  }
  return false;
}

export function mempalaceCommand(name: 'mempalace' | 'mempalace-mcp', env: NodeJS.ProcessEnv = process.env): string {
  const binDir = mempalaceBinDir(env);
  const installed = path.join(binDir, name);
  if (existsSync(installed)) return installed;
  // Development and non-container installs put the console script on PATH.
  return name;
}

export function mempalacePalacePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMPALACE_PALACE_PATH) return env.MEMPALACE_PALACE_PATH;
  const configDir = env.MEMPALACE_CONFIG_DIR || path.join(env.HOME || homedir(), '.mempalace');
  return path.join(configDir, 'palace');
}

export function mempalaceHookPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), ...MEMPALACE_HOOK_PATH);
}

export type MemPalaceProbe = {
  installed: boolean;
  version: string | null;
  binary: string;
  mcpBinary: string;
  palacePath: string;
  palaceInitialized: boolean;
  hookInstalled: boolean;
};

export function probeMempalaceFiles(env: NodeJS.ProcessEnv = process.env): Omit<MemPalaceProbe, 'version'> {
  const binary = mempalaceCommand('mempalace', env);
  const palacePath = mempalacePalacePath(env);
  return {
    installed: path.isAbsolute(binary) ? existsSync(binary) : onPath(binary, env),
    binary,
    mcpBinary: mempalaceCommand('mempalace-mcp', env),
    palacePath,
    // chroma.sqlite3 is the palace's own database; its absence means no memory
    // has ever been written, not that the tool is broken.
    palaceInitialized: existsSync(path.join(palacePath, 'chroma.sqlite3')),
    hookInstalled: existsSync(mempalaceHookPath(env)),
  };
}

/** Resolves the tool version; a missing binary or a hung one reads as null. */
export function mempalaceVersion(binary: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      finish(/(\d+\.\d+\.\d+\S*)/u.exec(output)?.[1] ?? null);
    });
  });
}

export type MempalaceRun = { code: number; stdout: string; stderr: string };

export function runMempalace(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<MempalaceRun> {
  const env = options.env ?? process.env;
  const binary = mempalaceCommand('mempalace', env);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MempalaceRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 124, stdout: '', stderr: 'mempalace timed out.' });
    }, options.timeoutMs ?? 120_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * The autosave hook the CLI loads from `<agentDir>/hooks/post`. It mines the
 * session transcript into the palace on a turn interval and on shutdown, which
 * is what makes memory writes happen without the agent asking for them.
 *
 * The mining budget matches the hook contract: a mine is CPU-bound and the
 * handler only gets 30s, so a slow one is left in the background instead of
 * being killed mid-insert. A second save is skipped while a miner is running —
 * the palace takes one writer.
 */
export function autosaveHookSource(binary: string): string {
  return `/**
 * MemPalace auto-save hook (installed by Gajae Code).
 *
 * Mines the current session transcript into the palace every \${SAVE_INTERVAL} entries
 * and once more on session shutdown. A mine is CPU-bound and the hook handler
 * only gets 30s, so a save never blocks past MINE_BUDGET_MS; the miner is left
 * to finish in the background. A running miner is never killed — that would
 * abandon an HNSW insert mid-write — and the palace allows one writer, so a
 * second save is skipped rather than queued.
 */
import type { HookAPI, HookContext } from "@gajae-code/coding-agent/hooks";

const MEMPALACE_BIN = process.env.MEMPALACE_BIN ?? ${JSON.stringify(binary)};
const STATE_FILE = \`\${process.env.HOME}/.mempalace/hook_state/gjc-state.json\`;
const SAVE_INTERVAL = 15;
const MINE_BUDGET_MS = 20_000;

type State = Record<string, number>;
let minerRunning = false;

async function readState(): Promise<State> {
	try {
		return JSON.parse(await Bun.file(STATE_FILE).text());
	} catch {
		return {};
	}
}

async function writeState(state: State): Promise<void> {
	try {
		await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {
		// best-effort; a missed write just means the next interval re-mines sooner
	}
}

async function mineSession(sessionFile: string, ctx: HookContext): Promise<boolean> {
	if (minerRunning) return false;
	minerRunning = true;

	let finished: Promise<boolean>;
	try {
		const proc = Bun.spawn([MEMPALACE_BIN, "mine", sessionFile, "--mode", "convos", "--extract", "general"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		finished = proc.exited.then((code) => code === 0, () => false);
	} catch {
		minerRunning = false;
		if (ctx.hasUI) ctx.ui.notify("MemPalace save failed to run", "warning");
		return false;
	}

	finished.then(() => {
		minerRunning = false;
	});

	const budget = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), MINE_BUDGET_MS));
	if (await Promise.race([finished, budget])) return true;

	if (ctx.hasUI) {
		ctx.ui.notify("MemPalace save still running in background; will retry", "warning");
	}
	return false;
}

export default function (pi: HookAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const entryCount = ctx.sessionManager.getEntries().length;
		const state = await readState();
		const lastSaved = state[sessionFile] ?? 0;
		if (entryCount - lastSaved < SAVE_INTERVAL) return;

		if (await mineSession(sessionFile, ctx)) {
			state[sessionFile] = entryCount;
			await writeState(state);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		await mineSession(sessionFile, ctx);

		const state = await readState();
		delete state[sessionFile];
		await writeState(state);
	});
}
`;
}

/** Writes the hook only when it is absent, so a local edit is never clobbered. */
export async function installMempalaceHook(env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; created: boolean }> {
  const target = mempalaceHookPath(env);
  if (existsSync(target)) return { path: target, created: false };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, autosaveHookSource(mempalaceCommand('mempalace', env)), 'utf8');
  return { path: target, created: true };
}
