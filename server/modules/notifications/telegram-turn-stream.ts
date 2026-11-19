/**
 * Streams a run into its Telegram topic the way the CLI's threaded renderer
 * does: reasoning and the answer are live-edited, tools are one message per
 * call that is edited when the result lands, and notices are their own rows.
 *
 * Everything is coalesced. A turn produces hundreds of deltas and Telegram
 * accepts a handful of edits a second, so text edits are throttled and only the
 * latest content is sent; a tool's result replaces its own message instead of
 * appending a second one. Delivery is skipped entirely when the chat cannot
 * take topics - a non-forum chat stays with flat notifications rather than
 * receiving a raw stream into the main thread.
 */

import type { NormalizedMessage } from '@/shared/types.js';

import { markdownToTelegramHtml } from './telegram-markdown.js';
import { escapeTelegramHtml } from './telegram-threads.js';
import { callTelegramApi, type TelegramApiResult } from './telegram.service.js';
import type { SessionTelegramTopic } from './telegram-session-topic.js';

const MAX_MESSAGE_CHARS = 3800;
const ARGS_CHARS = 1200;
const RESULT_CHARS = 1200;
const THINKING_CHARS = 1200;
const DEFAULT_EDIT_INTERVAL_MS = 2_000;
const DEFAULT_CALL_SPACING_MS = 1_200;
const MAX_TOOL_MESSAGES = 200;

export type TelegramTurnStreamOptions = {
  ensureTopic: (sessionId: string, provider: string | null) => Promise<SessionTelegramTopic | null>;
  /** Test seam; production calls the Bot API. */
  callApi?: (input: {
    botToken: string;
    method: string;
    body: Record<string, unknown>;
  }) => Promise<TelegramApiResult<unknown>>;
  editIntervalMs?: number;
  callSpacingMs?: number;
  logger?: (message: string) => void;
};

type ToolRow = { messageId: number | null; name: string };

type SessionState = {
  text: string;
  messageId: number | null;
  sentText: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  topic: Promise<SessionTelegramTopic | null> | null;
  tools: Map<string, ToolRow>;
  anonymousTools: number;
};

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

const safeJson = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function takeChunk(text: string): { head: string; rest: string } {
  if (text.length <= MAX_MESSAGE_CHARS) return { head: text, rest: '' };
  const window = text.slice(0, MAX_MESSAGE_CHARS);
  const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
  const cut = boundary > MAX_MESSAGE_CHARS * 0.6 ? boundary : MAX_MESSAGE_CHARS;
  return { head: text.slice(0, cut), rest: text.slice(cut).replace(/^\n+/u, '') };
}

export function createTelegramTurnStream(options: TelegramTurnStreamOptions): {
  observe: (input: { sessionId: string; provider: string | null; event: NormalizedMessage }) => void;
  waitForIdle: () => Promise<void>;
} {
  const editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  const callSpacingMs = options.callSpacingMs ?? DEFAULT_CALL_SPACING_MS;
  const log = options.logger ?? ((message: string) => console.warn('[Telegram]', message));
  const caller = options.callApi ?? ((input) => callTelegramApi(input));

  const sessions = new Map<string, SessionState>();
  const queues = new Map<string, Promise<void>>();
  let lastCallAt = 0;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  const api = async (botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramApiResult<unknown>> => {
    const wait = lastCallAt + callSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return caller({ botToken, method, body });
  };

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      text: '',
      messageId: null,
      sentText: '',
      textTimer: null,
      topic: null,
      tools: new Map(),
      anonymousTools: 0,
    };
    sessions.set(sessionId, created);
    return created;
  };

  const enqueue = (sessionId: string, task: () => Promise<void>): void => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => log(`delivery failed: ${error instanceof Error ? error.message : String(error)}`));
    queues.set(sessionId, next);
  };

  const topicFor = async (state: SessionState, sessionId: string, provider: string | null): Promise<SessionTelegramTopic | null> => {
    state.topic ??= Promise.resolve(options.ensureTopic(sessionId, provider)).catch((error) => {
      log(`could not resolve a topic: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    return state.topic;
  };

  const sendHtml = async (topic: SessionTelegramTopic, text: string): Promise<number | null> => {
    const result = await api(topic.botToken, 'sendMessage', {
      chat_id: topic.chatId,
      message_thread_id: Number(topic.threadId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!result.ok) {
      log(`sendMessage failed: ${result.description}`);
      return null;
    }
    const value = Number((result.result as { message_id?: unknown } | null)?.message_id ?? 0);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  const editHtml = async (topic: SessionTelegramTopic, messageId: number, text: string): Promise<void> => {
    const result = await api(topic.botToken, 'editMessageText', {
      chat_id: topic.chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    // An unchanged body is expected when a delta arrived after the last edit;
    // Telegram calls that an error, and it needs no second attempt.
    if (!result.ok && !/message is not modified/iu.test(result.description)) {
      log(`editMessageText failed: ${result.description}`);
    }
  };

  const flushText = async (sessionId: string, state: SessionState, provider: string | null): Promise<void> => {
    const topic = await topicFor(state, sessionId, provider);
    if (!topic) return;
    for (;;) {
      const { head, rest } = takeChunk(state.text);
      if (!head.trim()) return;
      const html = markdownToTelegramHtml(head);
      if (state.messageId !== null) {
        if (html !== markdownToTelegramHtml(state.sentText)) await editHtml(topic, state.messageId, html);
      } else {
        state.messageId = await sendHtml(topic, html);
      }
      state.sentText = head;
      if (!rest) return;
      // The head is frozen into its own message; the tail starts a new one so
      // an answer longer than Telegram's limit still streams in order.
      state.messageId = null;
      state.sentText = '';
      state.text = rest;
    }
  };

  const scheduleText = (sessionId: string, state: SessionState, provider: string | null): void => {
    if (state.textTimer) return;
    state.textTimer = setTimeout(() => {
      state.textTimer = null;
      enqueue(sessionId, () => flushText(sessionId, state, provider));
    }, editIntervalMs);
    state.textTimer.unref?.();
  };

  const flushNow = (sessionId: string, state: SessionState, provider: string | null): void => {
    if (state.textTimer) {
      clearTimeout(state.textTimer);
      state.textTimer = null;
    }
    enqueue(sessionId, () => flushText(sessionId, state, provider));
  };

  const sendRow = (sessionId: string, provider: string | null, state: SessionState, html: string): void => {
    enqueue(sessionId, async () => {
      const topic = await topicFor(state, sessionId, provider);
      if (topic) await sendHtml(topic, html);
    });
  };

  const sendOrEditTool = (
    sessionId: string,
    provider: string | null,
    state: SessionState,
    toolId: string,
    name: string,
    htmlFor: () => string,
  ): void => {
    // The name is registered before the queue runs so a result that follows
    // immediately can label its own message instead of guessing "tool".
    if (!state.tools.has(toolId) && state.tools.size < MAX_TOOL_MESSAGES) {
      state.tools.set(toolId, { messageId: null, name });
    }
    enqueue(sessionId, async () => {
      const topic = await topicFor(state, sessionId, provider);
      if (!topic) return;
      const row = state.tools.get(toolId);
      if (row?.messageId) {
        await editHtml(topic, row.messageId, htmlFor());
        return;
      }
      const messageId = await sendHtml(topic, htmlFor());
      if (messageId === null) return;
      if (row) row.messageId = messageId;
      else if (state.tools.size < MAX_TOOL_MESSAGES) state.tools.set(toolId, { messageId, name });
    });
  };

  const resetTurn = (state: SessionState): void => {
    state.text = '';
    state.messageId = null;
    state.sentText = '';
    state.tools.clear();
  };

  const observe = (input: { sessionId: string; provider: string | null; event: NormalizedMessage }): void => {
    const { sessionId, provider, event } = input;
    if (!sessionId || !event || typeof event.kind !== 'string') return;
    const state = stateFor(sessionId);
    const content = str(event.content);

    switch (event.kind) {
      case 'stream_delta': {
        if (!content) return;
        state.text += content;
        scheduleText(sessionId, state, provider);
        return;
      }
      case 'stream_end': {
        if (content) state.text = content;
        flushNow(sessionId, state, provider);
        return;
      }
      case 'text': {
        if (event.role !== 'assistant' || !content.trim()) return;
        if (event.isLocalCommandStdout === true) {
          sendRow(sessionId, provider, state, `<pre>${escapeTelegramHtml(clip(content, RESULT_CHARS))}</pre>`);
          return;
        }
        // A provider that does not stream sends the answer whole; it is still
        // the turn's answer, so it edits the same live message.
        state.text = content;
        flushNow(sessionId, state, provider);
        return;
      }
      case 'thinking': {
        if (!content.trim()) return;
        sendRow(
          sessionId,
          provider,
          state,
          `<b>🧠 Reasoning</b>\n<i>${escapeTelegramHtml(clip(content.trim(), THINKING_CHARS))}</i>`,
        );
        return;
      }
      case 'tool_use': {
        const name = str(event.toolName) || 'tool';
        const toolId = str(event.toolId) || `live-${state.anonymousTools++}`;
        const args = safeJson(event.toolInput);
        const html = `⚙ <b>${escapeTelegramHtml(clip(name, 300))}</b> — started`;
        sendOrEditTool(sessionId, provider, state, toolId, name, () => (args
          ? `${html}\n<pre>${escapeTelegramHtml(clip(args, ARGS_CHARS))}</pre>`
          : html));
        return;
      }
      case 'tool_result': {
        // Streaming partials are skipped: the final result already replaces the
        // message with everything the tool produced, and a per-chunk edit would
        // spend the chat's whole edit budget on one command.
        if (event.isFinal === false) return;
        const toolId = str(event.toolId);
        if (!toolId) {
          if (!content.trim()) return;
          sendRow(sessionId, provider, state, `<pre>${escapeTelegramHtml(clip(content, RESULT_CHARS))}</pre>`);
          return;
        }
        const name = state.tools.get(toolId)?.name ?? 'tool';
        const status = event.isError === true ? 'error' : 'ok';
        const body = content.trim()
          ? `<pre>${escapeTelegramHtml(clip(content, RESULT_CHARS))}</pre>`
          : '';
        const html = [
          `⚙ <b>${escapeTelegramHtml(clip(name, 300))}</b> — ${status}`,
          body,
        ].filter(Boolean).join('\n');
        sendOrEditTool(sessionId, provider, state, toolId, name, () => html);
        return;
      }
      case 'error': {
        sendRow(sessionId, provider, state, `❌ ${escapeTelegramHtml(clip(content || 'The run failed.', 1500))}`);
        return;
      }
      case 'system_notice': {
        if (!content.trim()) return;
        const icon = event.level === 'error' ? '❌' : event.level === 'warning' ? '⚠️' : 'ℹ️';
        sendRow(sessionId, provider, state, `${icon} ${escapeTelegramHtml(clip(content, 1500))}`);
        return;
      }
      case 'permission_request': {
        const tool = str(event.toolName);
        sendRow(sessionId, provider, state, [
          '🔐 <b>Approval needed</b>',
          tool ? `<code>${escapeTelegramHtml(tool)}</code>` : '',
        ].filter(Boolean).join('\n'));
        return;
      }
      case 'complete': {
        // The answer's final edit has to land before the turn is retired.
        enqueue(sessionId, async () => {
          if (state.textTimer) {
            clearTimeout(state.textTimer);
            state.textTimer = null;
          }
          await flushText(sessionId, state, provider);
          resetTurn(state);
        });
        return;
      }
      default:
        return;
    }
  };

  return {
    observe,
    waitForIdle: async () => {
      await Promise.all([...queues.values()]);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
