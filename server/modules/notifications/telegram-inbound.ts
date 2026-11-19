/**
 * Inbound Telegram replies for app sessions.
 *
 * A free-text reply inside a session's forum topic steers that session, which
 * is remote control of the agent. Every path therefore fails closed: the update
 * must come from the single paired chat, from a person rather than a bot, carry
 * a thread that maps to a known session, be first-seen, and have text.
 *
 * Only one process may long-poll a bot at a time. When the CLI's notification
 * daemon already owns this bot, Telegram answers 409 and this poller backs off
 * instead of fighting it; replies then stay with the CLI, which is the same
 * single-poller rule the daemon itself enforces.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fetchTelegramUpdates, type TelegramBotUpdate } from './telegram.service.js';

const DISABLED_RECHECK_MS = 15_000;
const CONFLICT_BACKOFF_MS = 60_000;
const FAILURE_BACKOFF_MS = 5_000;
const POLL_TIMEOUT_SECONDS = 25;
const SEEN_LIMIT = 500;

export type TelegramInboundDecision =
  | { kind: 'inject'; sessionId: string; text: string; updateId: number }
  | { kind: 'duplicate'; updateId: number }
  | { kind: 'ignore'; reason: string };

export type TelegramInboundContext = {
  pairedChatId: string;
  sessionForTopic: (topicId: string) => string | undefined;
  isSeen: (updateId: number) => boolean;
};

const asId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

export function decideTelegramInbound(
  update: TelegramBotUpdate,
  context: TelegramInboundContext,
): TelegramInboundDecision {
  const message = update.message;
  if (!message) return { kind: 'ignore', reason: 'no_message' };
  if (message.from?.is_bot === true) return { kind: 'ignore', reason: 'bot_message' };

  const chatId = asId(message.chat?.id);
  if (!chatId || chatId !== context.pairedChatId) return { kind: 'ignore', reason: 'wrong_chat' };

  const threadId = asId(message.message_thread_id);
  if (!threadId) return { kind: 'ignore', reason: 'no_topic' };

  const sessionId = context.sessionForTopic(threadId);
  if (!sessionId) return { kind: 'ignore', reason: 'unknown_topic' };

  const updateId = update.update_id;
  if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId < 0) {
    return { kind: 'ignore', reason: 'missing_update_id' };
  }
  if (context.isSeen(updateId)) return { kind: 'duplicate', updateId };

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return { kind: 'ignore', reason: 'empty_text' };

  return { kind: 'inject', sessionId, text, updateId };
}

type OffsetFile = { version: 1; chatId: string; offset: number };

const readOffset = (file: string, chatId: string): number => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OffsetFile>;
    if (parsed.version !== 1 || parsed.chatId !== chatId) return 0;
    return typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch {
    return 0;
  }
};

const writeOffset = (file: string, chatId: string, offset: number): void => {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const value: OffsetFile = { version: 1, chatId, offset };
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // A lost offset only means Telegram redelivers updates; the dedupe set in
    // `decideTelegramInbound` still rejects anything seen this process.
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export type TelegramInboundOptions = {
  readSettings: () => { botToken: string; chatId: string } | null;
  sessionForTopic: (topicId: string) => string | undefined;
  deliver: (sessionId: string, text: string) => void | Promise<unknown>;
  offsetPath: string;
  fetchImpl?: typeof fetch;
  logger?: (message: string) => void;
};

export function startTelegramInbound(options: TelegramInboundOptions): { stop: () => void } {
  const controller = new AbortController();
  const seen: number[] = [];
  const log = options.logger ?? ((message: string) => console.warn('[Telegram]', message));

  const isSeen = (updateId: number): boolean => seen.includes(updateId);
  const remember = (updateId: number): void => {
    seen.push(updateId);
    if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT);
  };

  const run = async (): Promise<void> => {
    let conflictReported = false;
    while (!controller.signal.aborted) {
      const settings = options.readSettings();
      if (!settings) {
        await sleep(DISABLED_RECHECK_MS);
        continue;
      }

      const offset = readOffset(options.offsetPath, settings.chatId);
      const result = await fetchTelegramUpdates({
        botToken: settings.botToken,
        offset,
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
        fetchImpl: options.fetchImpl,
        abortSignal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (!result.ok) {
        if (/conflict|terminated by other getUpdates/iu.test(result.description)) {
          if (!conflictReported) {
            log('another Bot API poller owns this bot (the CLI daemon); Telegram replies stay with it');
            conflictReported = true;
          }
          await sleep(CONFLICT_BACKOFF_MS);
          continue;
        }
        conflictReported = false;
        log(`getUpdates failed: ${result.description}`);
        await sleep(FAILURE_BACKOFF_MS);
        continue;
      }
      conflictReported = false;

      for (const update of result.result) {
        const updateId = update.update_id;
        if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId)) continue;
        const decision = decideTelegramInbound(update, {
          pairedChatId: settings.chatId,
          sessionForTopic: options.sessionForTopic,
          isSeen,
        });
        remember(updateId);
        if (decision.kind === 'inject') {
          try {
            await options.deliver(decision.sessionId, decision.text);
          } catch (error) {
            log(`could not deliver a reply: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        writeOffset(options.offsetPath, settings.chatId, updateId + 1);
      }
    }
  };

  void run().catch((error) => {
    console.error('[Telegram] Inbound poller stopped:', error instanceof Error ? error.message : String(error));
  });

  return {
    stop(): void {
      controller.abort();
    },
  };
}
