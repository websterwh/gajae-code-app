import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { GjcSessionsProvider } from '@/modules/providers/list/gjc/gjc-sessions.provider.js';

const APP_ID = 'app-handoff';
const PROVIDER_ID = 'sdk-handoff';
const DOCUMENT = '## Goal\n\nContinue the trainer integration.';
type Entry = Record<string, unknown>;

const handoff = (overrides: Entry = {}): Entry => ({
  type: 'custom_message', id: 'handoff', parentId: 'config',
  customType: 'handoff', display: true, attribution: 'agent',
  content: `<handoff-context>\n${DOCUMENT}\n</handoff-context>\n\n`
    + 'The above is a handoff document from a previous session. Use this context to continue the work seamlessly.',
  ...overrides,
});
const answer = (id: string, parentId: string): Entry => ({
  type: 'message', id, parentId, message: { role: 'assistant', content: id, stopReason: 'stop' },
});
const btwHandoff = (overrides: Entry = {}): Entry => ({
  type: 'custom_message', id: 'btw-handoff', parentId: 'config',
  customType: 'btw-handoff', display: true, attribution: 'user',
  content: '<btw-handoff nonce="abc">full framed side-chat payload</btw-handoff nonce="abc">',
  details: { exchangeCount: 2 },
  ...overrides,
});
const encode = (entries: unknown[], start = 0): string => `${entries.map((entry, index) => JSON.stringify(
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? { timestamp: new Date(Date.UTC(2026, 10, 12, 0, 0, start + index)).toISOString(), ...entry }
    : entry,
)).join('\n')}\n`;

async function withFixture(
  entries: unknown[],
  run: (context: { provider: GjcSessionsProvider; synchronizer: GjcSessionSynchronizer; filePath: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-handoff-history-'));
  const sessionDir = path.join(root, 'live-sessions');
  const workspace = path.join(root, 'workspace');
  const filePath = path.join(sessionDir, `${PROVIDER_ID}.jsonl`);
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousLiveDir = process.env.GJC_LIVE_SESSION_DIR;
  await mkdir(sessionDir);
  await mkdir(workspace);
  await writeFile(filePath, encode([
    { type: 'session', id: PROVIDER_ID, version: 5, cwd: workspace },
    { type: 'model_change', id: 'config', parentId: null },
    ...entries,
  ]));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.GJC_LIVE_SESSION_DIR = sessionDir;
  try {
    await initializeDatabase();
    sessionsDb.createAppSession(APP_ID, 'gjc', workspace);
    sessionsDb.assignProviderSessionId(APP_ID, 'gjc', PROVIDER_ID);
    sessionsDb.createSession(PROVIDER_ID, 'gjc', workspace, undefined, undefined, undefined, filePath);
    await run({ provider: new GjcSessionsProvider(), synchronizer: new GjcSessionSynchronizer(), filePath });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousLiveDir === undefined) delete process.env.GJC_LIVE_SESSION_DIR;
    else process.env.GJC_LIVE_SESSION_DIR = previousLiveDir;
    await rm(root, { recursive: true, force: true });
  }
}

test('a handoff document is the visible first message and the session title', async () => {
  await withFixture([handoff(), answer('reply', 'handoff')], async ({ provider, synchronizer, filePath }) => {
    const history = await provider.fetchHistory(APP_ID);
    assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: DOCUMENT },
      { role: 'assistant', content: 'reply' },
    ]);
    assert.equal(history.messages[0]?.turnId, 'handoff');
    assert.equal(history.messages[0]?.turnStatus, 'completed');

    assert.equal(await synchronizer.synchronizeFile(filePath), APP_ID);
    assert.equal(sessionsDb.getSessionById(APP_ID)?.custom_name, 'Goal Continue the trainer integration');
  });
});

test('a side-chat handoff shows a one-line marker instead of its framed payload', async () => {
  await withFixture([btwHandoff(), answer('reply', 'btw-handoff')], async ({ provider }) => {
    const history = await provider.fetchHistory(APP_ID);
    assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Side chat handed off to chat (2 exchanges).' },
      { role: 'assistant', content: 'reply' },
    ]);
  });
});

test('a side-chat handoff is ignored unless it is a displayed user message', async () => {
  for (const [label, overrides] of [
    ['hidden', { display: false }],
    ['agent-attributed', { attribution: 'agent' }],
  ] as const) {
    await withFixture([btwHandoff(overrides), answer('reply', 'btw-handoff')], async ({ provider }) => {
      const history = await provider.fetchHistory(APP_ID);
      assert.deepEqual(history.messages.map(({ content }) => content), ['reply'], label);
    });
  }
});

test('a handoff without a document stays out of history and title', async () => {
  const excluded: Array<[string, Entry]> = [
    ['hidden', { display: false }],
    ['missing display', { display: undefined }],
    ['empty content', { content: '' }],
    ['wrapper only', { content: '<handoff-context>\n\n</handoff-context>' }],
    ['non-string content', { content: { text: DOCUMENT } }],
    ['no content', { content: undefined }],
  ];

  for (const [label, overrides] of excluded) {
    await withFixture([handoff(overrides), answer('reply', 'handoff')], async ({ provider, synchronizer, filePath }) => {
      const history = await provider.fetchHistory(APP_ID);
      assert.deepEqual(history.messages.map(({ content }) => content), ['reply'], label);
      assert.equal(await synchronizer.deriveSessionTitle(filePath), null, label);
    });
  }
});
