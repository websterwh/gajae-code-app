import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { createTelegramTurnStream } from './telegram-turn-stream.js';

const topic = { botToken: '1:a', chatId: '-100', threadId: '42' };

function harness(options: { topic?: typeof topic | null } = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 100;
  const stream = createTelegramTurnStream({
    ensureTopic: async () => (options.topic === undefined ? topic : options.topic),
    callApi: async ({ method, body }) => {
      calls.push({ method, body });
      return { ok: true, result: { message_id: nextId++ } };
    },
    editIntervalMs: 0,
    callSpacingMs: 0,
    logger: () => {},
  });
  const send = (event: Partial<NormalizedMessage>): void => {
    stream.observe({
      sessionId: 's1',
      provider: 'gjc',
      event: {
        id: 'event', sessionId: 's1', timestamp: '2026-11-18T00:00:00.000Z', provider: 'gjc', kind: 'status', ...event,
      } as NormalizedMessage,
    });
  };
  return { calls, send, stream };
}

test('a streamed answer is sent once and then edited in its topic', async () => {
  const { calls, send, stream } = harness();
  send({ kind: 'stream_delta', content: 'Hello' });
  send({ kind: 'stream_delta', content: ' world' });
  send({ kind: 'stream_end', content: 'Hello world' });
  await stream.waitForIdle();

  assert.deepEqual(calls.map((call) => call.method), ['sendMessage']);
  assert.equal(calls[0].body.text, 'Hello world');
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.equal(calls[0].body.parse_mode, 'HTML');

  send({ kind: 'stream_end', content: 'Hello world, again' });
  await stream.waitForIdle();
  assert.deepEqual(calls.map((call) => call.method), ['sendMessage', 'editMessageText']);
  assert.equal(calls[1].body.message_id, 100);
});

test('the answer is rendered as Telegram HTML', async () => {
  const { calls, send, stream } = harness();
  send({ kind: 'stream_end', content: '**done** in `server/index.js`' });
  await stream.waitForIdle();
  assert.equal(calls[0].body.text, '<b>done</b> in <code>server/index.js</code>');
});

test('a long answer continues in a second message without losing the thread', async () => {
  const { calls, send, stream } = harness();
  send({ kind: 'stream_end', content: 'x'.repeat(4000) });
  await stream.waitForIdle();
  assert.deepEqual(calls.map((call) => call.method), ['sendMessage', 'sendMessage']);
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.equal(calls[1].body.message_thread_id, 42);
  assert.equal(String(calls[0].body.text).length, 3800);
});

test('a tool call is one message edited when its result lands', async () => {
  const { calls, send, stream } = harness();
  send({ kind: 'tool_use', toolId: 't1', toolName: 'read', toolInput: { path: 'a.ts' } });
  send({ kind: 'tool_result', toolId: 't1', content: '<output>', isFinal: true });
  await stream.waitForIdle();

  assert.deepEqual(calls.map((call) => call.method), ['sendMessage', 'editMessageText']);
  assert.equal(calls[0].body.message_id, undefined);
  assert.match(String(calls[0].body.text), /read/u);
  assert.match(String(calls[0].body.text), /started/u);
  assert.equal(calls[1].body.message_id, 100);
  assert.match(String(calls[1].body.text), /— ok/u);
  assert.match(String(calls[1].body.text), /&lt;output&gt;/u);
});

test('a non-forum chat receives no transcript at all', async () => {
  const { calls, send, stream } = harness({ topic: null });
  send({ kind: 'stream_delta', content: 'Hello' });
  send({ kind: 'stream_end', content: 'Hello' });
  send({ kind: 'tool_use', toolId: 't1', toolName: 'read' });
  send({ kind: 'complete', exitCode: 0 });
  await stream.waitForIdle();
  assert.deepEqual(calls, []);
});

test('reasoning, errors and approvals are their own rows', async () => {
  const { calls, send, stream } = harness();
  send({ kind: 'thinking', content: 'checking <files>' });
  send({ kind: 'permission_request', toolName: 'bash' });
  send({ kind: 'error', content: 'run failed' });
  await stream.waitForIdle();

  assert.deepEqual(calls.map((call) => call.method), ['sendMessage', 'sendMessage', 'sendMessage']);
  assert.match(String(calls[0].body.text), /🧠/u);
  assert.match(String(calls[0].body.text), /&lt;files&gt;/u);
  assert.match(String(calls[1].body.text), /bash/u);
  assert.match(String(calls[2].body.text), /run failed/u);
});
