import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatThreadIdentity, TelegramThreads } from './telegram-threads.js';

type Call = { url: string; body: Record<string, unknown> };

function routingFetch(routes: Record<string, unknown>, calls: Call[]): typeof fetch {
  return async (url, init) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const result = routes[method];
    return new Response(JSON.stringify(result === undefined ? { ok: false, description: `no ${method}` } : { ok: true, result }), { status: 200 });
  };
}

test('a private chat gets one topic per session with a pinned identity header', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-threads-'));
  const statePath = path.join(directory, 'threads.json');
  const calls: Call[] = [];
  try {
    // Bot API supports topics in private chats; `is_forum` is absent there and
    // must not suppress creation.
    const threads = new TelegramThreads({
      statePath,
      fetchImpl: routingFetch({
        createForumTopic: { message_thread_id: 42 },
        sendMessage: { message_id: 7 },
        pinChatMessage: {},
      }, calls),
    });
    const input = {
      sessionId: 'session-a',
      name: 'demo',
      botToken: '1:a',
      chatId: '5160963520',
      identity: formatThreadIdentity({ title: 'demo', sessionId: 'session-a', projectPath: '/workspace/demo' }),
    };

    assert.equal(await threads.ensureTopic(input), '42');
    assert.equal(await threads.ensureTopic(input), '42');
    assert.deepEqual(calls.map((call) => call.url.split('/').pop()), [
      'createForumTopic',
      'sendMessage',
      'pinChatMessage',
    ]);
    assert.deepEqual(calls[0].body, { chat_id: '5160963520', name: 'demo' });
    assert.equal(calls[1].body.message_thread_id, 42);
    assert.equal(calls[1].body.parse_mode, 'HTML');
    assert.match(String(calls[1].body.text), /<b>demo<\/b>/u);
    assert.deepEqual(calls[2].body, { chat_id: '5160963520', message_id: 7, disable_notification: true });

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      chatId: string;
      topics: Record<string, { topicId: string; identitySent: boolean }>;
    };
    assert.equal(persisted.chatId, '5160963520');
    assert.deepEqual(persisted.topics['session-a'], { topicId: '42', name: 'demo', identitySent: true });
    assert.equal(threads.sessionForTopic('42'), 'session-a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rejected or malformed topic creation falls back to flat delivery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-threads-'));
  const calls: Call[] = [];
  try {
    const threads = new TelegramThreads({
      statePath: path.join(directory, 'threads.json'),
      // No usable message_thread_id in the response.
      fetchImpl: routingFetch({ createForumTopic: { message_thread_id: 0 } }, calls),
    });
    const input = { sessionId: 'session-a', name: 'demo', botToken: '1:a', chatId: '-100' };

    assert.equal(await threads.ensureTopic(input), null);
    assert.deepEqual(calls.map((call) => call.url.split('/').pop()), ['createForumTopic']);
    assert.equal(threads.sessionForTopic('0'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new pairing never inherits the previous chat topics', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-threads-'));
  const statePath = path.join(directory, 'threads.json');
  const calls: Call[] = [];
  try {
    const threads = new TelegramThreads({
      statePath,
      fetchImpl: routingFetch({ createForumTopic: { message_thread_id: 55 } }, calls),
    });

    assert.equal(await threads.ensureTopic({ sessionId: 'session-a', name: 'demo', botToken: '1:a', chatId: '-100' }), '55');
    assert.equal(await threads.ensureTopic({ sessionId: 'session-a', name: 'demo', botToken: '1:a', chatId: '-200' }), '55');
    assert.equal(calls.filter((call) => call.url.endsWith('/createForumTopic')).length, 2);
    assert.equal(threads.topicForSession('session-a', '-100'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the identity header escapes HTML', () => {
  assert.equal(
    formatThreadIdentity({ title: '<demo>', sessionId: 'a&b', projectPath: '/w/demo' }),
    '<b>&lt;demo&gt;</b>\n• project: <code>demo</code>\n• session: <code>a&amp;b</code>',
  );
});
