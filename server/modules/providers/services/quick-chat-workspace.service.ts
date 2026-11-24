import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { AppError, WORKSPACES_ROOT } from '@/shared/utils.js';

/*
 * The quick chat's disposable workspace.
 *
 * A temporary chat must not start in whichever project the sidebar happens to
 * show: that is exactly the "it used the last folder" confusion. Each quick
 * chat gets its own folder under `<workspace root>/gajae-quick-chat/<sessionId>`,
 * outside every project, initialized as a git repository so the Changes view
 * and ordinary diffing work from the first turn. The folder is removed with the
 * session, and an unregistered folder never appears in the project list.
 *
 * The root is a parameter so tests can use a temporary directory; production
 * calls take the default.
 */

export const QUICK_CHAT_WORKSPACES_DIRECTORY = 'gajae-quick-chat';
const QUICK_CHAT_SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

const README = `# Quick chat workspace

A disposable folder for a quick chat. The agent works inside this directory and
nowhere else, and the folder is deleted with the conversation.
`;

export function quickChatWorkspacesRoot(root: string = WORKSPACES_ROOT): string {
  return path.join(root, QUICK_CHAT_WORKSPACES_DIRECTORY);
}

export function quickChatWorkspacePath(sessionId: string, root: string = WORKSPACES_ROOT): string | null {
  return QUICK_CHAT_SESSION_ID.test(sessionId)
    ? path.join(quickChatWorkspacesRoot(root), sessionId)
    : null;
}

function gitInit(directory: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('git', ['init', '--quiet'], { cwd: directory, shell: false, stdio: 'ignore' });
    // No git on this machine still leaves a usable folder.
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

export async function createQuickChatWorkspace(sessionId: string, root: string = WORKSPACES_ROOT): Promise<string> {
  const target = quickChatWorkspacePath(sessionId, root);
  if (!target) {
    throw new AppError('Quick chat workspace id is invalid.', { code: 'INVALID_QUICK_CHAT_ID', statusCode: 400 });
  }
  await mkdir(target, { recursive: true });
  await gitInit(target);
  try {
    await writeFile(path.join(target, 'README.md'), README, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return realpath(target);
}

/**
 * True only for the folder this session's quick chat owns: the path's own name
 * is the session id and its parent is the quick-chat root. Deleting a session
 * must never be able to remove an arbitrary directory.
 */
export function isQuickChatWorkspace(sessionId: string, projectPath: string | null | undefined): boolean {
  if (!projectPath) return false;
  const resolved = path.resolve(projectPath);
  return path.basename(resolved) === sessionId
    && path.basename(path.dirname(resolved)) === QUICK_CHAT_WORKSPACES_DIRECTORY;
}

export async function removeQuickChatWorkspace(sessionId: string, projectPath?: string | null, root: string = WORKSPACES_ROOT): Promise<boolean> {
  if (projectPath !== undefined && !isQuickChatWorkspace(sessionId, projectPath)) return false;
  const target = projectPath ? path.resolve(projectPath) : quickChatWorkspacePath(sessionId, root);
  if (!target) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}
