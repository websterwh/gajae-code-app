import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyNotificationPatch,
  notificationView,
  readNotificationsFromYaml,
  telegramCredentials,
  writeNotificationsToYaml,
} from './gjc-notifications.config.js';

const CONFIG = `notifications: 
  enabled: true
  telegram: 
    botToken: 8912231532:AAEf-xyz
    chatId: "5160963520"
    enabled: true
    rich: 
      enabled: true
    sound: all
  discord: 
    enabled: false
  redact: false
  verbosity: lean
  sessionScope: all
statusLine: 
  preset: default-usage
# keep this comment
agency: 
  note: keep me
`;

test('reads the telegram channel with schema defaults for absent keys', () => {
  const view = notificationView(readNotificationsFromYaml(CONFIG));

  assert.equal(view.enabled, true);
  assert.equal(view.telegram.enabled, true);
  assert.equal(view.telegram.hasBotToken, true);
  assert.equal(view.telegram.chatId, '5160963520');
  assert.equal(view.telegram.sound, 'all');
  assert.equal(view.telegram.rich, true);
  assert.equal(view.telegram.richDraft, false);
  assert.equal(view.telegram.streaming, true);
  assert.equal(view.telegram.toolActivity, false);
  assert.equal(view.verbosity, 'lean');
  assert.equal(view.sessionScope, 'all');
});

test('telegram credentials come back trimmed from the stored block', () => {
  const stored = telegramCredentials(readNotificationsFromYaml(
    'notifications:\n  telegram:\n    botToken: " 123:abc "\n    chatId: 5160963520\n',
  ));

  assert.deepEqual(stored, { botToken: '123:abc', chatId: '5160963520' });
});

test('a patch keeps unrelated keys, the stored token and unknown channels', () => {
  const next = writeNotificationsToYaml(CONFIG, applyNotificationPatch(readNotificationsFromYaml(CONFIG), {
    telegram: { enabled: false, chatId: ' 999 ', botToken: '  ', toolActivity: true },
    verbosity: 'verbose',
  }));

  assert.match(next, /^statusLine: /m);
  assert.match(next, /^# keep this comment$/m);
  assert.match(next, /^ {2}note: keep me$/m);
  assert.match(next, /^ {2}discord:$/m);
  assert.match(next, /botToken: '8912231532:AAEf-xyz'/);
  assert.match(next, /chatId: '999'/);
  assert.doesNotMatch(next, /^notifications: [\s\S]*statusLine:/m);

  const view = notificationView(readNotificationsFromYaml(next));
  assert.equal(view.telegram.enabled, false);
  assert.equal(view.telegram.chatId, '999');
  assert.equal(view.telegram.toolActivity, true);
  assert.equal(view.verbosity, 'verbose');
});

test('a new token replaces the stored one and a missing block is appended', () => {
  const withToken = writeNotificationsToYaml(CONFIG, applyNotificationPatch(readNotificationsFromYaml(CONFIG), {
    telegram: { botToken: '123:new' },
  }));
  assert.match(withToken, /botToken: '123:new'/);

  const appended = writeNotificationsToYaml('disableAllHooks: true\n', { enabled: true, telegram: { enabled: false } });
  assert.match(appended, /^disableAllHooks: true$/m);
  assert.deepEqual(readNotificationsFromYaml(appended), { enabled: true, telegram: { enabled: false } });
});

test('a block that cannot round-trip is refused instead of corrupted', () => {
  const exotic = 'notifications:\n  telegram:\n    activation:\n      - chat: 1\n';

  assert.throws(() => writeNotificationsToYaml(exotic, applyNotificationPatch(readNotificationsFromYaml(exotic), {
    enabled: true,
  })), /would not survive a rewrite/);
});
