import { closeSync, existsSync, openSync, readSync, renameSync } from 'node:fs';
import { copyFile, cp, mkdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { getGjcCliSessionDir, getGjcLiveSessionRoot } from './shared/utils.js';

/**
 * Moves older app-written transcripts into the GJC CLI's session directories.
 *
 * The app used to keep every transcript under `~/.gajae-app/gjc-live-sessions`,
 * a flat store the CLI never scans, so a web conversation could not be resumed
 * from the terminal. The CLI lists `~/.gjc/agent/sessions/<cwd-slug>/` (its
 * legacy layout) and its managed `v2-*` scope; new sessions are created in the
 * managed scope now, and this relocates the ones that predate that.
 *
 * Moving is deliberately conservative: the transcript and its artifact
 * directory are carried over only when the destination is free, and the row is
 * repointed only after the copy succeeded. Running sessions are never touched;
 * callers invoke this before a turn starts.
 */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readHeaderCwd(file: string): string | undefined {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, read).toString('utf8').split('\n', 1)[0];
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    return header.type === 'session' && typeof header.cwd === 'string' && path.isAbsolute(header.cwd)
      ? header.cwd
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Relocates one transcript when it still lives in the app's own flat store.
 * Returns the new path, or undefined when the session is already somewhere the
 * CLI (or the app's new store) can see it. The caller looks the row up again.
 */
export async function relocateLiveGjcTranscript(
  sessionId: string,
  options: { liveRoot?: string; agentDir?: string } = {},
): Promise<string | undefined> {
  // An explicit live root is a caller's choice (isolated dev, tests) and must
  // be left exactly where it was pointed. An explicit argument bypasses that.
  if (!options.liveRoot && process.env.GJC_LIVE_SESSION_DIR) return undefined;
  const { sessionsDb } = await import('./modules/database/index.js');
  const row = sessionsDb.getSessionByProviderSessionId('gjc', sessionId) ?? sessionsDb.getSessionById(sessionId);
  const source = row?.jsonl_path;
  if (!row || row.provider !== 'gjc' || !source || !existsSync(source)) return undefined;
  const liveRoot = path.resolve(options.liveRoot ?? getGjcLiveSessionRoot());
  if (!isWithin(liveRoot, path.resolve(source))) return undefined;

  const cwd = readHeaderCwd(source) ?? row.project_path;
  if (!cwd) return undefined;
  const destinationDir = options.agentDir
    ? getGjcCliSessionDir(cwd, options.agentDir)
    : getGjcCliSessionDir(cwd);
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  const destination = path.join(destinationDir, path.basename(source));
  if (existsSync(destination)) return undefined;

  const sourceStem = source.replace(/\.jsonl$/u, '');
  const destinationStem = destination.replace(/\.jsonl$/u, '');
  await moveFile(source, destination);
  // Artifacts sit beside the transcript in a directory of the same stem; a
  // presence sidecar may exist as well. Both travel with it or the transcript's
  // artifact:// links break.
  for (const [from, to] of [
    [sourceStem, destinationStem],
    [`${source}.presence.json`, `${destination}.presence.json`],
    [`${sourceStem}.presence.json`, `${destinationStem}.presence.json`],
  ]) {
    if (!existsSync(from)) continue;
    try {
      const metadata = await stat(from);
      if (metadata.isDirectory()) await moveDirectory(from, to);
      else await moveFile(from, to);
    } catch {
      // A companion that cannot follow does not invalidate the transcript move;
      // the transcript itself is authoritative and already in place.
    }
  }
  sessionsDb.updateSessionJsonlPath(row.session_id, destination);
  return destination;
}

/**
 * Boot-time sweep for rows the app wrote before it used the CLI-visible store.
 * Running sessions cannot exist yet, so every row is safe to move; a row whose
 * file is already visible, missing or unreadable is simply skipped.
 */
export async function relocateAllLiveGjcTranscripts(
  options: { liveRoot?: string; agentDir?: string } = {},
): Promise<number> {
  if (!options.liveRoot && process.env.GJC_LIVE_SESSION_DIR) return 0;
  const { sessionsDb } = await import('./modules/database/index.js');
  let relocated = 0;
  for (const row of sessionsDb.getAllSessionsWithTranscriptPath()) {
    if (row.provider !== 'gjc') continue;
    try {
      if (await relocateLiveGjcTranscript(row.session_id, options)) relocated += 1;
    } catch {
      // One unreadable transcript must not stop the rest of the sweep.
    }
  }
  return relocated;
}
