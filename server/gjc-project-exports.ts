import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * A record of the files `/export` wrote.
 *
 * The chat can only offer a download for the message that produced the file,
 * which stops being useful as soon as the page reloads or another session is
 * opened. The file itself outlives the message, so the run that wrote it
 * appends one line here and the app lists whatever still exists on disk.
 *
 * The record is deliberately just the facts the runtime already has: the
 * destination, the directory the run belonged to, and the app session that ran
 * it. The session is kept because a session can run in its own worktree, where
 * the export lands outside the project directory and only that session id
 * resolves it for the download route.
 */
export type ProjectExportRecord = {
  /** Absolute path the export wrote. */
  path: string;
  /** The run's project directory, used to scope the list to one project. */
  projectPath: string;
  /** App session that ran `/export`; null when the run had no app session. */
  sessionId: string | null;
  /** ISO timestamp of the export. */
  at: string;
};

const FILE_NAME = 'exports.jsonl';

/**
 * Beside the agent's sessions on the mounted config, so the list survives a
 * container recreate the same way the transcripts do.
 */
export function projectExportsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
  return path.join(agentDir, FILE_NAME);
}

export async function recordProjectExport(
  record: ProjectExportRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = projectExportsFilePath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** A damaged line is skipped, not fatal: the other exports are still usable. */
export async function readProjectExports(file: string): Promise<ProjectExportRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const records: ProjectExportRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ProjectExportRecord>;
      if (typeof parsed.path !== 'string' || !parsed.path) continue;
      records.push({
        path: parsed.path,
        projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : '',
        sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null,
        at: typeof parsed.at === 'string' ? parsed.at : '',
      });
    } catch {
      continue;
    }
  }
  return records;
}

const inside = (candidate: string, root: string): boolean => {
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
};

/**
 * The exports one project can offer: its own session's exports (which may live
 * in a worktree elsewhere) plus anything under its directory. The same file
 * exported twice is one row, keeping the newest record.
 */
export function projectExportsFor(
  records: readonly ProjectExportRecord[],
  options: { projectPath: string; sessionId?: string | null },
): ProjectExportRecord[] {
  const latest = new Map<string, ProjectExportRecord>();
  for (const record of records) {
    const forSession = Boolean(options.sessionId) && record.sessionId === options.sessionId;
    if (!forSession && !inside(record.path, options.projectPath) && record.projectPath !== options.projectPath) continue;
    const previous = latest.get(record.path);
    if (!previous || previous.at < record.at) latest.set(record.path, record);
  }
  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
