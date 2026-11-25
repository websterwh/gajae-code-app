import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { relocateAllLiveGjcTranscripts, relocateLiveGjcTranscript } from './gjc-transcript-store.js';
import { closeConnection, initializeDatabase, sessionsDb } from './modules/database/index.js';
import { getGjcCliSessionDir } from './shared/utils.js';

/**
 * A transcript written before the app used the CLI-visible store has to move,
 * not copy: the app row and the terminal must keep reading one file. This pins
 * the destination, the artifact sidecar and the row update together.
 */
async function withFixture(runTest: (fixture: {
  root: string;
  liveRoot: string;
  agentDir: string;
  projectPath: string;
  sessionId: string;
  transcriptPath: string;
}) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-transcript-store-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const liveRoot = path.join(root, 'live-sessions');
  const agentDir = path.join(root, 'agent');
  const projectPath = path.join(root, 'workspace', 'project');
  await mkdir(liveRoot, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  const sessionId = 'relocate-session-1';
  const transcriptPath = path.join(liveRoot, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(transcriptPath, [
    JSON.stringify({ type: 'session', version: 5, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } }),
  ].join('\n') + '\n', { mode: 0o600 });
  const artifactDir = transcriptPath.replace(/\.jsonl$/u, '');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, '1.bash.log'), 'tool output', { mode: 0o600 });
  sessionsDb.createSession(sessionId, 'gjc', projectPath, 'Move me', undefined, undefined, transcriptPath);

  try {
    await runTest({ root, liveRoot, agentDir, projectPath, sessionId, transcriptPath });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('a live-root transcript moves into the CLI session store with its artifacts and row', async () => {
  await withFixture(async ({ agentDir, liveRoot, projectPath, sessionId, transcriptPath }) => {
    const relocated = await relocateLiveGjcTranscript(sessionId, { liveRoot, agentDir });
    const expectedDirectory = getGjcCliSessionDir(projectPath, agentDir);
    const expected = path.join(expectedDirectory, path.basename(transcriptPath));

    assert.equal(relocated, expected);
    assert.equal(existsSync(transcriptPath), false, 'the old copy must not be left behind');
    assert.equal(existsSync(expected), true);
    assert.equal(
      existsSync(path.join(expected.replace(/\.jsonl$/u, ''), '1.bash.log')),
      true,
      'artifact:// links keep resolving beside the moved transcript',
    );
    const header = JSON.parse((await readFile(expected, 'utf8')).split('\n', 1)[0] ?? '{}') as { cwd?: string };
    assert.equal(header.cwd, projectPath);
    assert.equal(sessionsDb.getSessionById(sessionId)?.jsonl_path, expected);
  });
});

test('the boot sweep relocates every live-root row in one pass', async () => {
  await withFixture(async ({ agentDir, liveRoot, projectPath, sessionId, transcriptPath }) => {
    const secondId = 'relocate-session-2';
    const secondPath = path.join(liveRoot, `2026-01-01T00-00-00-001Z_${secondId}.jsonl`);
    await writeFile(secondPath, JSON.stringify({ type: 'session', version: 5, id: secondId, timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath }) + '\n', { mode: 0o600 });
    sessionsDb.createSession(secondId, 'gjc', projectPath, 'Second', undefined, undefined, secondPath);

    assert.equal(await relocateAllLiveGjcTranscripts({ liveRoot, agentDir }), 2);
    assert.equal(existsSync(transcriptPath), false);
    assert.equal(existsSync(secondPath), false);
    assert.equal(sessionsDb.getSessionById(sessionId)?.jsonl_path, path.join(getGjcCliSessionDir(projectPath, agentDir), path.basename(transcriptPath)));
    assert.equal(sessionsDb.getSessionById(secondId)?.jsonl_path, path.join(getGjcCliSessionDir(projectPath, agentDir), path.basename(secondPath)));
  });
});

test('a transcript already outside the live root is left alone', async () => {
  await withFixture(async ({ agentDir, liveRoot, projectPath, sessionId, transcriptPath }) => {
    assert.equal(await relocateLiveGjcTranscript(sessionId, { liveRoot: path.join(projectPath, 'elsewhere'), agentDir }), undefined);
    assert.equal(existsSync(transcriptPath), true);
  });
});

test('an existing destination is never overwritten', async () => {
  await withFixture(async ({ agentDir, liveRoot, projectPath, sessionId, transcriptPath }) => {
    const destination = path.join(getGjcCliSessionDir(projectPath, agentDir), path.basename(transcriptPath));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'someone else\n', { mode: 0o600 });

    assert.equal(await relocateLiveGjcTranscript(sessionId, { liveRoot, agentDir }), undefined);
    assert.equal(await readFile(destination, 'utf8'), 'someone else\n');
    assert.equal(existsSync(transcriptPath), true, 'the source stays when it cannot be moved safely');
  });
});
