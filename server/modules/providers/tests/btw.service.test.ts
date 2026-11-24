import assert from 'node:assert/strict';
import test from 'node:test';

import type { Response } from 'express';

import {
  BTW_MAX_EXCHANGES,
  BTW_MAX_QUESTION_BYTES,
  createBtwStream,
  parseBtwRequest,
} from '../services/btw.service.js';

function fakeResponse() {
  const chunks: string[] = [];
  const response = {
    writableEnded: false,
    write(chunk: string) {
      chunks.push(chunk);
    },
    end() {
      response.writableEnded = true;
    },
  };
  return { response: response as unknown as Response, chunks, state: response };
}

function events(chunks: string[]) {
  return chunks.join('').split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

test('parseBtwRequest accepts a question and bounded earlier exchanges', () => {
  assert.deepEqual(parseBtwRequest({ question: '  why?  ', exchanges: [{ question: 'a', answer: 'b' }] }), {
    question: 'why?',
    exchanges: [{ question: 'a', answer: 'b' }],
  });
  assert.deepEqual(parseBtwRequest({ question: 'why?' }), { question: 'why?', exchanges: [] });
});

test('parseBtwRequest refuses blank, oversized and malformed requests', () => {
  assert.throws(() => parseBtwRequest({ question: '   ' }), /question is required/);
  assert.throws(() => parseBtwRequest({ question: 'x'.repeat(BTW_MAX_QUESTION_BYTES + 1) }), /limited/);
  assert.throws(() => parseBtwRequest({ question: 'why?', exchanges: 'nope' }), /must be an array/);
  assert.throws(() => parseBtwRequest({ question: 'why?', exchanges: [{ question: '', answer: 'b' }] }), /nonempty question/);
  assert.throws(
    () => parseBtwRequest({ question: 'why?', exchanges: Array.from({ length: BTW_MAX_EXCHANGES + 1 }, (_, index) => ({ question: `q${index}`, answer: 'a' })) }),
    /at most/,
  );
});

test('createBtwStream forwards deltas and turns the run terminal into one done event', () => {
  const { response, chunks, state } = fakeResponse();
  const stream = createBtwStream(response, 'session-1');

  stream.writer.send({ kind: 'stream_delta', content: 'hel' });
  stream.writer.send({ kind: 'stream_delta', content: 'lo' });
  stream.writer.send({ kind: 'stream_end', content: 'hello' });
  assert.equal(stream.finished(), false);

  stream.writer.send({ kind: 'complete', exitCode: 0 });
  assert.equal(stream.finished(), true);
  assert.equal(state.writableEnded, true);
  assert.deepEqual(events(chunks), [
    { type: 'delta', text: 'hel' },
    { type: 'delta', text: 'lo' },
    { type: 'done', text: 'hello' },
  ]);
});

test('createBtwStream turns a failed run terminal into an error event', () => {
  const { response, chunks } = fakeResponse();
  const stream = createBtwStream(response, 'session-1');

  stream.writer.send({ kind: 'error', content: 'provider exploded' });
  stream.writer.send({ kind: 'complete', exitCode: 1 });

  assert.deepEqual(events(chunks), [{ type: 'error', message: 'provider exploded' }]);
});
