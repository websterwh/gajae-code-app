import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
import { notifyRunStopped } from '@/modules/notifications/services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an enabled Telegram block delivers app-session notifications to the Bot API', async (t) => {
  const previousAgentDir = process.env.GJC_WORKER_AGENT_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), 'notification-telegram-'));
  const agentDir = path.join(directory, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'config.yml'), [
    'notifications:',
    '  enabled: true',
    '  telegram:',
    '    enabled: true',
    "    botToken: '123:abc'",
    "    chatId: '5160963520'",
    '',
  ].join('\n'));
  process.env.GJC_WORKER_AGENT_DIR = agentDir;

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('telegram-user', 'hash');
      const userId = Number(user.id);
      notificationPreferencesDb.updatePreferences(userId, {
        channels: { desktop: false, webPush: false },
        events: { actionRequired: true, stop: true, error: true },
      });

      await notifyRunStopped({ userId, provider: 'gjc', sessionId: null, stopReason: 'completed' });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/bot123:abc\/sendMessage$/u);
      assert.equal(calls[0].body.text, 'GJC: completed');
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.GJC_WORKER_AGENT_DIR;
    else process.env.GJC_WORKER_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('desktop payload uses the app session id when notified with a provider session id', async () => {
  const sentMessages = [];
  const fakeSocket = {
    OPEN: 1,
    readyState: 1,
    send(message, callback) {
      sentMessages.push(JSON.parse(message));
      callback?.();
    },
    close() {},
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('notify-user', 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { desktop: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      registerDesktopNotificationClient({ userId, deviceId: 'test-device', ws: fakeSocket });
      sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
      sessionsDb.assignProviderSessionId('app-session-1', 'claude', 'claude-native-1');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId: 'claude-native-1',
        stopReason: 'completed',
      });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sentMessages.length, 1);
      const payload = sentMessages[0]?.payload;
      assert.equal(payload?.data?.sessionId, 'app-session-1');
      assert.match(payload?.data?.tag, /app-session-1/);
    });
  } finally {
    unregisterDesktopNotificationClient(fakeSocket);
  }
});
