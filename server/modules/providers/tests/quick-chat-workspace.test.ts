import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createQuickChatWorkspace,
  isQuickChatWorkspace,
  QUICK_CHAT_WORKSPACES_DIRECTORY,
  quickChatWorkspacePath,
  removeQuickChatWorkspace,
} from '../services/quick-chat-workspace.service.js';

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'quick-chat-root-'));
}

test('a quick chat gets its own folder outside every project, removed with the session', async () => {
  const root = await temporaryRoot();
  const sessionId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const created = await createQuickChatWorkspace(sessionId, root);

  assert.equal(path.basename(created), sessionId);
  assert.equal(path.basename(path.dirname(created)), QUICK_CHAT_WORKSPACES_DIRECTORY);
  assert.equal((await stat(created)).isDirectory(), true);
  assert.match(await readFile(path.join(created, 'README.md'), 'utf8'), /disposable/i);

  assert.equal(await removeQuickChatWorkspace(sessionId, created, root), true);
  await assert.rejects(stat(created));
});

test('removal never touches a path that is not that session\'s quick-chat folder', async () => {
  const root = await temporaryRoot();
  const sessionId = 'session-owned';
  const other = path.join(root, 'gajae-quick-chat', 'another-session');
  await createQuickChatWorkspace('another-session', root);

  assert.equal(isQuickChatWorkspace(sessionId, other), false);
  assert.equal(await removeQuickChatWorkspace(sessionId, other, root), false);
  assert.equal((await stat(other)).isDirectory(), true, 'the other session keeps its folder');

  const projectPath = path.join(root, 'a-project', sessionId);
  assert.equal(isQuickChatWorkspace(sessionId, projectPath), false);
  assert.equal(await removeQuickChatWorkspace(sessionId, projectPath, root), false);
  await assert.rejects(stat(projectPath), 'nothing was created or removed for a project path');
});

test('an invalid session id never resolves to a path', () => {
  assert.equal(quickChatWorkspacePath('../escape'), null);
  assert.equal(quickChatWorkspacePath(''), null);
});
