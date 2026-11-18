import assert from 'node:assert/strict';
import test from 'node:test';

import { boundJobEventPayload, JOB_EVENT_PAYLOAD_BUDGET_BYTES } from './gjc-job-event-payload.js';

test('a payload inside the frame budget is returned untouched', () => {
  const payload = { kind: 'stream_delta', content: 'hi' };
  assert.equal(boundJobEventPayload(payload), payload);
});

test('an oversized string keeps its kind and a bounded head and tail preview', () => {
  const content = `${'head'.repeat(40_000)}${'tail'.repeat(40_000)}`;
  const bounded = boundJobEventPayload({ kind: 'tool_result', content }) as { kind: string; content: string };
  assert.equal(bounded.kind, 'tool_result');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= JOB_EVENT_PAYLOAD_BUDGET_BYTES);
  assert.ok(bounded.content.startsWith('head'));
  assert.ok(bounded.content.endsWith('tail'));
  assert.match(bounded.content, /bytes omitted/u);
});

test('bulk that is not a string collapses to a marker that keeps its kind', () => {
  const payload = { kind: 'tool_result', rows: Array.from({ length: 5_000 }, (_, index) => ({ index, value: 1 })) };
  const bounded = boundJobEventPayload(payload) as { kind: string; truncated: boolean; bytes: number };
  assert.equal(bounded.kind, 'tool_result');
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.bytes > JOB_EVENT_PAYLOAD_BUDGET_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') < 512);
});

test('a bounded preview never splits a multi-byte character', () => {
  const payload = { kind: 'tool_result', content: '€'.repeat(60_000) };
  const bounded = boundJobEventPayload(payload) as { content: string };
  assert.doesNotMatch(bounded.content, /\\uFFFD|\uFFFD/u);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= JOB_EVENT_PAYLOAD_BUDGET_BYTES);
});
