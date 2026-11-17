import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Usage totals across every gjc transcript on disk.
 *
 * The app's own database records sessions but not the tokens they spent, so the
 * only place a lifetime number can come from is the transcripts themselves: one
 * `usage` block per assistant message in `~/.gjc/agent/sessions`. Reading all of
 * them is expensive, which is why the result is cached, capped and streamed -
 * a single multi-hundred-megabyte tool result must not be buffered or parsed.
 */
export type UsageTotals = {
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

export type UsageModelRow = UsageTotals & { model: string; provider: string };
export type UsageProjectRow = UsageTotals & { name: string; path: string; lastActiveAt: string | null };
export type UsageDayRow = { date: string; total: number; cost: number };

export type UsageOverview = {
  generatedAt: string;
  root: string;
  scanned: { files: number; bytes: number; truncated: boolean };
  totals: UsageTotals;
  models: UsageModelRow[];
  projects: UsageProjectRow[];
  daily: UsageDayRow[];
  firstActivityAt: string | null;
  lastActivityAt: string | null;
};

/** A transcript line can hold a whole tool result; only usage lines are parsed. */
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_FILES = 4_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_MODELS = 12;
const DAILY_WINDOW_DAYS = 183;
const CACHE_MS = 30_000;
const FILE_CONCURRENCY = 4;

const emptyTotals = (): UsageTotals => ({
  sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
});

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Streams newline-delimited UTF-8, dropping any line that grows past the cap
 * instead of buffering it. `readline` would hold the whole line first.
 */
async function* readBoundedLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath);
  let chunks: Buffer[] = [];
  let length = 0;
  let dropping = false;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0A, start);
      const end = newline === -1 ? buffer.length : newline;
      const size = end - start;
      if (!dropping) {
        if (length + size > MAX_LINE_BYTES) {
          chunks = [];
          length = 0;
          dropping = true;
        } else if (size > 0) {
          chunks.push(buffer.subarray(start, end));
          length += size;
        }
      }
      if (newline === -1) break;
      if (!dropping) {
        const line = Buffer.concat(chunks, length).toString('utf8');
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      chunks = [];
      length = 0;
      dropping = false;
      start = newline + 1;
    }
  }

  if (!dropping && length > 0) {
    const line = Buffer.concat(chunks, length).toString('utf8');
    yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}

async function collectTranscripts(directory: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A missing or unreadable sessions root is an empty history, not an error.
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTranscripts(fullPath, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

type FileScan = {
  used: boolean;
  turns: number;
  totals: UsageTotals;
  models: Map<string, UsageModelRow>;
  days: Map<string, UsageDayRow>;
  cwd: string | null;
  lastActivityAt: string | null;
  bytes: number;
};

function timestampOf(entry: Record<string, unknown>, message: Record<string, unknown> | null): string | null {
  for (const candidate of [entry.timestamp, message?.timestamp]) {
    if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return new Date(candidate).toISOString();
  }
  return null;
}

async function scanTranscript(filePath: string): Promise<FileScan> {
  const scan: FileScan = {
    used: false,
    turns: 0,
    totals: emptyTotals(),
    models: new Map(),
    days: new Map(),
    cwd: null,
    lastActivityAt: null,
    bytes: 0,
  };

  for await (const line of readBoundedLines(filePath)) {
    scan.bytes += line.length;
    // Cheap rejection first: assistant messages are a small minority of the
    // lines and only they carry a usage block.
    if (!line.includes('"usage"')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = recordOf(parsed);
    if (!entry) continue;
    const message = recordOf(entry.message);
    const cwd = entry.cwd ?? message?.cwd;
    if (!scan.cwd && typeof cwd === 'string' && cwd) scan.cwd = cwd;

    const usage = recordOf(message?.usage) ?? recordOf(entry.usage);
    if (!usage) continue;

    const input = num(usage.input) || num(usage.inputTokens) || num(usage.input_tokens);
    const output = num(usage.output) || num(usage.outputTokens) || num(usage.output_tokens);
    const cacheRead = num(usage.cacheRead) || num(usage.cacheReadTokens) || num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cacheWrite) || num(usage.cacheWriteTokens) || num(usage.cache_creation_input_tokens);
    const total = num(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    if (total <= 0) continue;

    const costRecord = recordOf(usage.cost);
    const cost = costRecord ? num(costRecord.total) : num(usage.cost);
    const model = typeof message?.model === 'string' && message.model ? message.model : 'unknown';
    const provider = typeof message?.provider === 'string' && message.provider ? message.provider : 'gjc';

    scan.used = true;
    scan.turns += 1;
    scan.totals.input += input;
    scan.totals.output += output;
    scan.totals.cacheRead += cacheRead;
    scan.totals.cacheWrite += cacheWrite;
    scan.totals.total += total;
    scan.totals.cost += cost;

    const modelKey = `${provider}\u0000${model}`;
    const modelRow = scan.models.get(modelKey) ?? { model, provider, ...emptyTotals() };
    modelRow.turns += 1;
    modelRow.total += total;
    modelRow.cost += cost;
    scan.models.set(modelKey, modelRow);

    const timestamp = timestampOf(entry, message);
    if (timestamp) {
      if (!scan.lastActivityAt || timestamp > scan.lastActivityAt) scan.lastActivityAt = timestamp;
      const day = timestamp.slice(0, 10);
      const dayRow = scan.days.get(day) ?? { date: day, total: 0, cost: 0 };
      dayRow.total += total;
      dayRow.cost += cost;
      scan.days.set(day, dayRow);
    }
  }

  return scan;
}

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

function sessionsRoot(root?: string): string {
  if (root) return root;
  const agentDir = process.env.GJC_WORKER_AGENT_DIR || path.join(os.homedir(), '.gjc', 'agent');
  return path.join(agentDir, 'sessions');
}

let cache: { at: number; value: UsageOverview } | null = null;
let inFlight: Promise<UsageOverview> | null = null;

export async function collectUsageOverview(options: { refresh?: boolean; root?: string } = {}): Promise<UsageOverview> {
  if (!options.refresh && !options.root && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (!options.refresh && !options.root && inFlight) return inFlight;

  const run = async (): Promise<UsageOverview> => {
    const root = sessionsRoot(options.root);
    const discovered = await collectTranscripts(root);
    const truncatedByCount = discovered.length > MAX_FILES;
    const files = truncatedByCount ? discovered.slice(0, MAX_FILES) : discovered;

    const totals = emptyTotals();
    const models = new Map<string, UsageModelRow>();
    const projects = new Map<string, UsageProjectRow>();
    const days = new Map<string, UsageDayRow>();
    let bytes = 0;
    let firstActivityAt: string | null = null;
    let lastActivityAt: string | null = null;
    let truncatedByBytes = false;
    let cursor = 0;

    const worker = async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        const filePath = files[index];
        if (bytes > MAX_BYTES) {
          truncatedByBytes = true;
          continue;
        }
        let scan: FileScan;
        try {
          scan = await scanTranscript(filePath);
        } catch {
          continue;
        }
        bytes += scan.bytes;
        if (!scan.used) continue;

        totals.sessions += 1;
        totals.turns += scan.turns;
        totals.input += scan.totals.input;
        totals.output += scan.totals.output;
        totals.cacheRead += scan.totals.cacheRead;
        totals.cacheWrite += scan.totals.cacheWrite;
        totals.total += scan.totals.total;
        totals.cost += scan.totals.cost;

        for (const [key, row] of scan.models) {
          const merged = models.get(key) ?? { model: row.model, provider: row.provider, ...emptyTotals() };
          merged.sessions += 1;
          merged.turns += row.turns;
          merged.total += row.total;
          merged.cost += row.cost;
          models.set(key, merged);
        }

        const projectPath = scan.cwd ?? path.basename(path.dirname(filePath));
        const projectKey = projectPath;
        const project = projects.get(projectKey) ?? {
          name: path.basename(projectPath) || projectPath,
          path: projectPath,
          ...emptyTotals(),
          lastActiveAt: null,
        };
        project.sessions += 1;
        project.turns += scan.turns;
        project.total += scan.totals.total;
        project.cost += scan.totals.cost;
        if (scan.lastActivityAt && (!project.lastActiveAt || scan.lastActivityAt > project.lastActiveAt)) {
          project.lastActiveAt = scan.lastActivityAt;
        }
        projects.set(projectKey, project);

        for (const [day, row] of scan.days) {
          const merged = days.get(day) ?? { date: day, total: 0, cost: 0 };
          merged.total += row.total;
          merged.cost += row.cost;
          days.set(day, merged);
        }

        for (const candidate of scan.days.keys()) {
          if (!firstActivityAt || candidate < firstActivityAt) firstActivityAt = candidate;
        }
        if (scan.lastActivityAt && (!lastActivityAt || scan.lastActivityAt > lastActivityAt)) {
          lastActivityAt = scan.lastActivityAt;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, files.length) }, worker));

    const windowStart = new Date(Date.now() - (DAILY_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const overview: UsageOverview = {
      generatedAt: new Date().toISOString(),
      root,
      scanned: {
        files: files.length,
        bytes,
        truncated: truncatedByCount || truncatedByBytes,
      },
      totals: {
        ...totals,
        cost: round(totals.cost),
      },
      models: [...models.values()]
        .sort((left, right) => right.total - left.total)
        .slice(0, MAX_MODELS)
        .map((row) => ({ ...row, cost: round(row.cost) })),
      projects: [...projects.values()]
        .sort((left, right) => right.total - left.total)
        .map((row) => ({ ...row, cost: round(row.cost) })),
      daily: [...days.values()]
        .filter((row) => row.date >= windowStart)
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((row) => ({ ...row, cost: round(row.cost) })),
      firstActivityAt,
      lastActivityAt,
    };

    return overview;
  };

  if (options.root) return run();

  inFlight = run().then(
    (value) => {
      cache = { at: Date.now(), value };
      inFlight = null;
      return value;
    },
    (error: unknown) => {
      inFlight = null;
      throw error;
    },
  );
  return inFlight;
}

/** Test seam: forget the cached overview. */
export function resetUsageOverviewCache(): void {
  cache = null;
  inFlight = null;
}
