import { strict as assert } from 'node:assert';
import { mkdtemp as createEphemeralDirectory, rm as discardEphemeralDirectory, writeFile } from 'node:fs/promises';
import { tmpdir as temporaryDirectoryRoot } from 'node:os';
import { join as composePath } from 'node:path';
import { test } from 'node:test';

import { closeConnection as releaseDatabaseConnection, initializeDatabase as initializeSessionSchema, sessionsDb, sessionWorktreesDb } from '@/modules/database/index.js';
import { pruneSessionsWithMissingTranscripts } from '@/modules/providers/index.js';

/*
 * The forward session scan only ever discovers transcripts; nothing used to
 * un-discover one deleted by hand outside the app, so its row (and the
 * "Could not delete" chat it belonged to) survived every refresh and every
 * container recreation forever. This is the reconciliation half of that fix.
 */

async function withSessionDatabase(action: (storeDir: string) => void | Promise<void>): Promise<void> {
  const inheritedDatabasePath = process.env.DATABASE_PATH;
  const ephemeralStore = await createEphemeralDirectory(composePath(temporaryDirectoryRoot(), 'gajae-session-prune-'));

  releaseDatabaseConnection();
  process.env.DATABASE_PATH = composePath(ephemeralStore, 'gajae.sqlite');
  try {
    await initializeSessionSchema();
    await action(ephemeralStore);
  } finally {
    releaseDatabaseConnection();
    if (inheritedDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = inheritedDatabasePath;
    await discardEphemeralDirectory(ephemeralStore, { recursive: true, force: true });
  }
}

test('a session whose transcript file is gone from disk is pruned on reconciliation', async () => {
  await withSessionDatabase(async (storeDir) => {
    const transcriptPath = composePath(storeDir, 'deleted.jsonl');
    await writeFile(transcriptPath, '{}\n');
    sessionsDb.createSession('session-deleted', 'gjc', '/workspaces/scratch', 'check current time', undefined, undefined, transcriptPath);
    await discardEphemeralDirectory(transcriptPath, { force: true });

    const pruned = pruneSessionsWithMissingTranscripts();

    assert.equal(pruned, 1);
    assert.equal(sessionsDb.getSessionById('session-deleted'), null);
  });
});

test('a session whose transcript file still exists on disk is left alone', async () => {
  await withSessionDatabase(async (storeDir) => {
    const transcriptPath = composePath(storeDir, 'kept.jsonl');
    await writeFile(transcriptPath, '{}\n');
    sessionsDb.createSession('session-kept', 'gjc', '/workspaces/scratch', 'keep me', undefined, undefined, transcriptPath);

    const pruned = pruneSessionsWithMissingTranscripts();

    assert.equal(pruned, 0);
    assert.ok(sessionsDb.getSessionById('session-kept'));
  });
});

test('a session that never had a transcript path is never pruned (new/pending sessions)', async () => {
  await withSessionDatabase(async () => {
    sessionsDb.createSession('session-pending', 'gjc', '/workspaces/scratch', 'brand new chat');

    const pruned = pruneSessionsWithMissingTranscripts();

    assert.equal(pruned, 0);
    assert.ok(sessionsDb.getSessionById('session-pending'));
  });
});

test('a worktree-bound session keeps its row even if its transcript path is missing - its checkout, not the file, makes it real', async () => {
  await withSessionDatabase(async (storeDir) => {
    const transcriptPath = composePath(storeDir, 'worktree.jsonl');
    sessionsDb.createSession('session-worktree', 'gjc', '/workspaces/scratch', 'worktree chat', undefined, undefined, transcriptPath);
    sessionWorktreesDb.create('session-worktree', 'job-session-worktree', '/workspaces/scratch');

    const pruned = pruneSessionsWithMissingTranscripts();

    assert.equal(pruned, 0);
    assert.ok(sessionsDb.getSessionById('session-worktree'));
  });
});
