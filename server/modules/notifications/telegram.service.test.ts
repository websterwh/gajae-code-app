import assert from 'node:assert/strict';
import test from 'node:test';

import { sendTelegramMessage, TELEGRAM_API_BASE } from './telegram.service.js';

test('posts the chat id and text to the bot endpoint', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const result = await sendTelegramMessage({
    botToken: '123:abc',
    chatId: '-100',
    text: 'hello',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.deepEqual(result, { ok: true, description: '' });
  assert.equal(calls[0].url, `${TELEGRAM_API_BASE}/bot123:abc/sendMessage`);
  assert.deepEqual(calls[0].body, { chat_id: '-100', text: 'hello', disable_web_page_preview: true });
});

test("a rejected call returns Telegram's description", async () => {
  const result = await sendTelegramMessage({
    botToken: '123:abc',
    chatId: '-100',
    text: 'hello',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }),
  });

  assert.deepEqual(result, { ok: false, description: 'Bad Request: chat not found' });
});

test('a non-JSON answer still reports the status', async () => {
  const result = await sendTelegramMessage({
    botToken: '123:abc',
    chatId: '-100',
    text: 'hello',
    fetchImpl: async () => new Response('gateway timeout', { status: 504 }),
  });

  assert.equal(result.ok, false);
  assert.match(result.description, /504/u);
});

test('a network failure is reported instead of thrown', async () => {
  const result = await sendTelegramMessage({
    botToken: '123:abc',
    chatId: '-100',
    text: 'hello',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });

  assert.deepEqual(result, { ok: false, description: 'connect ECONNREFUSED' });
});
