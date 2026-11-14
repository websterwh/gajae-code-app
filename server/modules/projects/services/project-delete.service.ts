import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isManagedWorktreePath, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { resetProjectPermissions } from '@/modules/projects/services/project-permissions.service.js';
import { AppError, normalizeProjectPath, WORKSPACES_ROOT } from '@/shared/utils.js';

export type DeleteProjectResult = {
  projectId: string;
  projectPath: string;
  deletedFiles: boolean;
  deletedSessions: number;
};

type DeleteProjectOptions = { deleteFiles?: boolean };

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Deleting a workspace is the one project action that reaches the filesystem,
 * so the paths that would take the machine with them are refused: a filesystem
 * root, the home directory, the root every workspace lives under, and any
 * directory that contains another registered project.
 */
function assertErasable(projectPath: string, projectId: string): void {
  const target = normalizeProjectPath(projectPath);
  const protectedPaths = [
    path.parse(target).root,
    normalizeProjectPath(os.homedir()),
    normalizeProjectPath(WORKSPACES_ROOT),
  ].map(normalizeProjectPath);
  if (protectedPaths.includes(target)) {
    throw new AppError('This workspace path is protected and cannot be deleted.', {
      code: 'PROJECT_PATH_PROTECTED',
      statusCode: 409,
    });
  }

  const nested = [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()]
    .filter((row) => row.project_id !== projectId)
    .find((row) => isInside(row.project_path, target));
  if (nested) {
    throw new AppError(`"${nested.project_path}" is inside this workspace; delete it first.`, {
      code: 'PROJECT_CONTAINS_OTHER_PROJECTS',
      statusCode: 409,
    });
  }
}

async function unlinkQuietly(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * Removes a project from the app for good. The rows and their transcripts go
 * first, because a transcript left on disk is re-indexed into the project the
 * user just removed. `deleteFiles` then erases the workspace directory itself;
 * without it the folder stays exactly as it was.
 */
export async function deleteProject(projectId: string, options: DeleteProjectOptions = {}): Promise<DeleteProjectResult> {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) throw new AppError('projectId is required', { code: 'PROJECT_ID_REQUIRED', statusCode: 400 });

  const project = projectsDb.getProjectById(id);
  if (!project) {
    throw new AppError(`Unknown projectId: ${id}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  const projectPath = project.project_path;
  if (isManagedWorktreePath(projectPath)) {
    throw new AppError('Managed job worktrees cannot be deleted as projects', {
      code: 'PROJECT_PATH_IS_MANAGED_WORKTREE',
      statusCode: 400,
    });
  }

  const deleteFiles = options.deleteFiles === true;
  // Checked before anything is dropped: a refusal has to leave the project whole.
  if (deleteFiles) assertErasable(projectPath, id);

  const sessions = sessionsDb.deleteSessionsByProjectPath(projectPath);
  for (const session of sessions) await unlinkQuietly(session.jsonl_path);
  resetProjectPermissions(id);
  projectsDb.deleteProjectById(id);
  if (deleteFiles) await fs.rm(projectPath, { recursive: true, force: true });

  return { projectId: id, projectPath, deletedFiles: deleteFiles, deletedSessions: sessions.length };
}
