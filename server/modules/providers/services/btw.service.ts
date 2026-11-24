import type { Response } from 'express';

import { AppError } from '@/shared/utils.js';

export const BTW_MAX_QUESTION_BYTES = 16 * 1024;
export const BTW_MAX_CONTEXT_BYTES = 64 * 1024;
export const BTW_MAX_EXCHANGES = 12;

export type BtwExchange = { question: string; answer: string };

const fail = (message: string): never => {
  throw new AppError(message, { code: 'INVALID_BTW_REQUEST', statusCode: 400 });
};

/**
 * Validate the one thing a browser supplies to a side chat. The question and
 * earlier exchanges are bounded exactly as the runtime bounds its own panel so
 * a long-lived side chat cannot grow without limit.
 */
export function parseBtwRequest(raw: unknown): { question: string; exchanges: BtwExchange[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('A side-chat request must be an object.');
  const body = raw as Record<string, unknown>;
  if (typeof body.question !== 'string' || !body.question.trim()) return fail('A side-chat question is required.');
  if (Buffer.byteLength(body.question, 'utf8') > BTW_MAX_QUESTION_BYTES) {
    return fail(`Side-chat questions are limited to ${BTW_MAX_QUESTION_BYTES} UTF-8 bytes.`);
  }
  if (body.exchanges !== undefined && !Array.isArray(body.exchanges)) return fail('exchanges must be an array.');
  const exchanges: BtwExchange[] = [];
  let bytes = 0;
  for (const [index, entry] of (body.exchanges as unknown[] | undefined ?? []).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`exchanges[${index}] must be a { question, answer } object.`);
    }
    const exchange = entry as Record<string, unknown>;
    if (typeof exchange.question !== 'string' || !exchange.question.trim() || typeof exchange.answer !== 'string') {
      return fail(`exchanges[${index}] must contain a nonempty question and a string answer.`);
    }
    bytes += Buffer.byteLength(exchange.question, 'utf8') + Buffer.byteLength(exchange.answer, 'utf8');
    if (bytes > BTW_MAX_CONTEXT_BYTES) return fail('The side-chat history is too large.');
    exchanges.push({ question: exchange.question, answer: exchange.answer });
    if (exchanges.length > BTW_MAX_EXCHANGES) return fail(`A side chat keeps at most ${BTW_MAX_EXCHANGES} earlier exchanges.`);
  }
  return { question: body.question.trim(), exchanges };
}

type BtwStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/**
 * Bridges one worker run to the response as `text/event-stream`.
 *
 * The worker emits the same normalized frames as a chat turn, so this is where
 * they become side-chat events: deltas stream, `stream_end` carries the final
 * text, and the run's `complete` frame closes the response. No frame from this
 * writer reaches the chat registry or the session transcript.
 */
export function createBtwStream(res: Response, appSessionId: string) {
  let text = '';
  let failure = '';
  let finished = false;

  const write = (event: BtwStreamEvent) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const finish = (event: BtwStreamEvent) => {
    if (finished) return;
    finished = true;
    write(event);
    res.end();
  };

  const writer = {
    getAppSessionId: () => appSessionId,
    send(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const frame = value as { kind?: unknown; content?: unknown; exitCode?: unknown };
      if (frame.kind === 'stream_delta' && typeof frame.content === 'string') {
        text += frame.content;
        write({ type: 'delta', text: frame.content });
        return;
      }
      if (frame.kind === 'stream_end' && typeof frame.content === 'string') {
        text = frame.content;
        return;
      }
      if (frame.kind === 'error') {
        if (!failure) failure = typeof frame.content === 'string' && frame.content ? frame.content : 'Side-chat request failed.';
        return;
      }
      if (frame.kind === 'complete') {
        if (frame.exitCode) finish({ type: 'error', message: failure || 'Side-chat request failed.' });
        else finish({ type: 'done', text });
      }
    },
  };

  return {
    writer,
    finished: () => finished,
    fail(message: string) {
      finish({ type: 'error', message });
    },
    end() {
      if (!finished) finish({ type: 'error', message: failure || 'Side chat ended without an answer.' });
    },
  };
}
