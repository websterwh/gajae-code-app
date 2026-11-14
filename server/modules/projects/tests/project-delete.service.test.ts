import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { deleteProject } from '@/modules/projects/services/project-delete.service.js';
import { AppError } from '@/shared/utils.js';

/*
 * Removing a project from the app for good.
 *
 * The directory belongs to the user, so only an explicit `deleteFiles` reaches
 * it. Without that flag the workspace stops being listed and its conversations
 * stop existing, while every file in the folder stays exactly as it was.
 */

async function withDatabase(action: (directory: string) => Promise<void>): Promise<void> {
  const previousDatabase = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'project-delete-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'app.sqlite');
  try {
    await initializeDatabase();
    await action(directory);
  } finally {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    await rm(directory, { recursive: true, force: true });
  }
}

async function missing(target: string): Promise<boolean> {
  return access(target).then(() => false, () => true);
}

async function seedWorkspace(directory: string) {
  const projectPath = path.join(directory, 'workspace');
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'notes.txt'), 'keep me\n', 'utf8');
  const transcriptPath = path.join(directory, 'session.jsonl');
  await writeFile(transcriptPath, '{"role":"user","content":"keep me"}\n', 'utf8');
  const created = projectsDb.createProjectPath(projectPath);
  assert.ok(created.project);
  sessionsDb.createSession('session-1', 'gjc', projectPath, 'Fix the parser', undefined, undefined, transcriptPath);
  return { projectId: created.project.project_id, projectPath, transcriptPath };
}

test('removing a workspace drops the row, its sessions and transcripts but keeps the folder', async () => {
  await withDatabase(async (directory) => {
    const { projectId, projectPath, transcriptPath } = await seedWorkspace(directory);

    const result = await deleteProject(projectId);

    assert.deepEqual(result, { projectId, projectPath, deletedFiles: false, deletedSessions: 1 });
    assert.equal(projectsDb.getProjectById(projectId), null);
    assert.deepEqual(projectsDb.getProjectPaths(), [], 'the workspace leaves every list');
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath).length, 0);
    assert.ok(await missing(transcriptPath), 'the transcript goes with the rows it belonged to');
    assert.equal(await readFile(path.join(projectPath, 'notes.txt'), 'utf8'), 'keep me\n');
  });
});

test('erasing the workspace directory is a separate, explicit choice', async () => {
  await withDatabase(async (directory) => {
    const { projectId, projectPath } = await seedWorkspace(directory);

    const result = await deleteProject(projectId, { deleteFiles: true });

    assert.equal(result.deletedFiles, true);
    assert.ok(await missing(projectPath), 'the folder is gone');
  });
});

test('an unknown project is a 404 rather than a silent no-op', async () => {
  await withDatabase(async () => {
    await assert.rejects(deleteProject('missing-project'), (error: unknown) =>
      error instanceof AppError && error.code === 'PROJECT_NOT_FOUND' && error.statusCode === 404,
    );
  });
});

test('the home directory and the filesystem root are refused even when erase is requested', async () => {
  await withDatabase(async (directory) => {
    for (const protectedPath of [os.homedir(), path.parse(directory).root]) {
      const created = projectsDb.createProjectPath(protectedPath);
      assert.ok(created.project);
      await assert.rejects(deleteProject(created.project.project_id, { deleteFiles: true }), (error: unknown) =>
        error instanceof AppError && error.code === 'PROJECT_PATH_PROTECTED' && error.statusCode === 409,
      );
      assert.ok(projectsDb.getProjectById(created.project.project_id), 'a refusal leaves the project whole');
    }
  });
});

test('a workspace that holds another project cannot be erased underneath it', async () => {
  await withDatabase(async (directory) => {
    const parentPath = path.join(directory, 'parent');
    const childPath = path.join(parentPath, 'child');
    await mkdir(childPath, { recursive: true });
    const parent = projectsDb.createProjectPath(parentPath);
    const child = projectsDb.createProjectPath(childPath);
    assert.ok(parent.project && child.project);

    await assert.rejects(deleteProject(parent.project.project_id, { deleteFiles: true }), (error: unknown) =>
      error instanceof AppError && error.code === 'PROJECT_CONTAINS_OTHER_PROJECTS' && error.statusCode === 409,
    );
    assert.equal(await missing(parentPath), false, 'the refused folder is still there');
  });
});
