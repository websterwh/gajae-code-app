import assert from 'node:assert/strict';
import test from 'node:test';

import { decideTelegramInbound } from './telegram-inbound.js';

const context = (overrides: Partial<Parameters<typeof decideTelegramInbound>[1]> = {}) => ({
  pairedChatId: '-100',
  sessionForTopic: (topicId: string) => (topicId === '42' ? 'session-a' : undefined),
  isSeen: () => false,
  ...overrides,
});

const update = (message: Record<string, unknown>) => ({
  update_id: 10,
  message: { chat: { id: -100 }, message_thread_id: 42, text: 'continue', from: { is_bot: false }, ...message },
});

test('a reply in a known topic injects a trimmed user turn', () => {
  assert.deepEqual(decideTelegramInbound(update({ text: '  keep going  ' }), context()), {
    kind: 'inject',
    sessionId: 'session-a',
    text: 'keep going',
    updateId: 10,
  });
});

test('routing fails closed outside the paired chat, known topic or a person', () => {
  assert.deepEqual(
    decideTelegramInbound(update({ chat: { id: -200 } }), context()),
    { kind: 'ignore', reason: 'wrong_chat' },
  );
  assert.deepEqual(
    decideTelegramInbound(update({ message_thread_id: 99 }), context()),
    { kind: 'ignore', reason: 'unknown_topic' },
  );
  assert.deepEqual(
    decideTelegramInbound(update({ message_thread_id: undefined }), context()),
    { kind: 'ignore', reason: 'no_topic' },
  );
  assert.deepEqual(
    decideTelegramInbound(update({ from: { is_bot: true } }), context()),
    { kind: 'ignore', reason: 'bot_message' },
  );
  assert.deepEqual(
    decideTelegramInbound(update({ text: '   ' }), context()),
    { kind: 'ignore', reason: 'empty_text' },
  );
});

test('a replayed update is reported as a duplicate, not injected twice', () => {
  assert.deepEqual(decideTelegramInbound(update({}), context({ isSeen: () => true })), {
    kind: 'duplicate',
    updateId: 10,
  });
});
