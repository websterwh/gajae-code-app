import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { daemonOwnsTelegram, resolveTelegramOwner, workerNotificationsEnv } from './telegram-ownership.js';

const config = [
  'notifications:',
  '  enabled: true',
  '  telegram:',
  '    enabled: true',
  "    botToken: '123:abc'",
  "    chatId: '-1001234567890'",
  '',
].join('\n');

/** Every case gets its own agent dir, passed explicitly so no real config leaks in. */
async function withAgentDir(run: (env: NodeJS.ProcessEnv) => void, configured = true): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-ownership-'));
  const agentDir = path.join(directory, 'agent');
  try {
    await mkdir(agentDir, { recursive: true });
    if (configured) await writeFile(path.join(agentDir, 'config.yml'), config);
    run({ GJC_WORKER_AGENT_DIR: agentDir });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the app owns Telegram unless daemon ownership is requested', () => {
  assert.equal(resolveTelegramOwner({}), 'app');
  assert.equal(resolveTelegramOwner({ GJC_TELEGRAM_OWNER: 'app' }), 'app');
  assert.equal(resolveTelegramOwner({ GJC_TELEGRAM_OWNER: 'daemon' }), 'daemon');
  assert.equal(resolveTelegramOwner({ GJC_TELEGRAM_OWNER: ' DAEMON ' }), 'daemon');
});

test('daemon ownership needs a configured Telegram block', async () => {
  await withAgentDir((env) => {
    assert.equal(daemonOwnsTelegram({ ...env, GJC_TELEGRAM_OWNER: 'daemon' }), true);
  });
  await withAgentDir((env) => {
    assert.equal(daemonOwnsTelegram({ ...env, GJC_TELEGRAM_OWNER: 'daemon' }), false);
  }, false);
});

test('workers opt into the daemon only in daemon mode', async () => {
  await withAgentDir((env) => {
    assert.equal(workerNotificationsEnv(env), '0');
    assert.equal(workerNotificationsEnv({ ...env, GJC_TELEGRAM_OWNER: 'daemon' }), '1');
  });
  await withAgentDir((env) => {
    // A daemon request without configuration must not disable the app's sender.
    assert.equal(workerNotificationsEnv({ ...env, GJC_TELEGRAM_OWNER: 'daemon' }), '0');
  }, false);
});

test('an explicit notification switch wins over the ownership flag', () => {
  assert.equal(workerNotificationsEnv({ GJC_NOTIFICATIONS: '0' }), '0');
  assert.equal(workerNotificationsEnv({ GJC_NOTIFICATIONS: '1' }), '1');
});
