/**
 * MemPalace auto-save hook (installed by Gajae Code when MemPalace is the
 * memory provider).
 *
 * Mines the current session transcript into the palace every SAVE_INTERVAL
 * entries and once more on session shutdown. A mine is CPU-bound and the hook
 * handler only gets 30s, so a save never blocks past MINE_BUDGET_MS; the miner
 * is left to finish in the background. A running miner is never killed — that
 * would abandon an HNSW insert mid-write — and the palace allows one writer, so
 * a second save is skipped rather than queued behind it.
 */
import type { HookAPI, HookContext } from "@gajae-code/coding-agent/hooks";

const MEMPALACE_BIN = process.env.MEMPALACE_BIN ?? `${process.env.HOME}/.gjc/app/bin/mempalace`;
const STATE_FILE = `${process.env.HOME}/.mempalace/hook_state/gjc-state.json`;
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

/** Resolves true when the mine finished cleanly, false when it failed or is
 * still running past the budget. Never rejects. */
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

	// Clear the guard when the miner actually exits, not when we stop waiting on
	// it, so a slow miner is never stacked behind a second one.
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
