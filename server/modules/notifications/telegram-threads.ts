/**
 * One Telegram topic per app session, the same shape the CLI uses: a session's
 * notifications land in its own topic, and a reply in that topic can be routed
 * back to the session. Bot API supports topics in private chats as well as
 * forum supergroups, so both are used; a chat that rejects creation falls back
 * to flat delivery. The mapping is durable because recreating a topic on every
 * restart would spray duplicates through the chat.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { telegramAgentDir } from './telegram-settings.js';
import { callTelegramApi } from './telegram.service.js';

export type TelegramThreadRecord = {
  topicId: string;
  name: string;
  identitySent: boolean;
};

export type TelegramThreadState = {
  version: 1;
  chatId: string;
  topics: Record<string, TelegramThreadRecord>;
};

export type EnsureTopicInput = {
  sessionId: string;
  name: string;
  botToken: string;
  chatId: string;
  /** One-time pinned header describing the session; sent before the first notification. */
  identity?: string;
};

const emptyState = (): TelegramThreadState => ({ version: 1, chatId: '', topics: {} });
const isValidTopicId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d*$/u.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** The header the CLI pins once per topic, minus the fields the app does not know. */
export function formatThreadIdentity(input: {
  title: string;
  sessionId?: string | null;
  projectPath?: string | null;
}): string {
  const lines = [`<b>${escapeTelegramHtml(input.title)}</b>`];
  const project = input.projectPath ? path.basename(input.projectPath) : '';
  if (project) lines.push(`• project: <code>${escapeTelegramHtml(project)}</code>`);
  if (input.sessionId) lines.push(`• session: <code>${escapeTelegramHtml(input.sessionId)}</code>`);
  return lines.join('\n');
}

export function readThreadState(file: string): TelegramThreadState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.chatId !== 'string' || !isRecord(parsed.topics)) {
      return emptyState();
    }
    const topics: Record<string, TelegramThreadRecord> = {};
    for (const [sessionId, raw] of Object.entries(parsed.topics)) {
      if (!isRecord(raw) || !isValidTopicId(raw.topicId)) continue;
      topics[sessionId] = {
        topicId: raw.topicId,
        name: typeof raw.name === 'string' ? raw.name : '',
        identitySent: raw.identitySent === true,
      };
    }
    return { version: 1, chatId: parsed.chatId, topics };
  } catch {
    return emptyState();
  }
}

function writeThreadState(file: string, state: TelegramThreadState): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

const topicName = (name: string): string => {
  const flat = name.replace(/\s+/gu, ' ').trim();
  return flat.length > 128 ? flat.slice(0, 125) : flat || 'Gajae Code';
};

export type TelegramThreadsOptions = {
  statePath: string;
  fetchImpl?: typeof fetch;
};

export class TelegramThreads {
  private state: TelegramThreadState | null = null;
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly options: TelegramThreadsOptions) {}

  private loaded(): TelegramThreadState {
    if (!this.state) this.state = readThreadState(this.options.statePath);
    return this.state;
  }

  private persist(): void {
    try {
      writeThreadState(this.options.statePath, this.loaded());
    } catch (error) {
      console.error('[Telegram] Could not persist topic state:', error instanceof Error ? error.message : String(error));
    }
  }

  topicForSession(sessionId: string, chatId: string): string | undefined {
    const state = this.loaded();
    if (state.chatId && state.chatId !== chatId) return undefined;
    return state.topics[sessionId]?.topicId;
  }

  /** Topic id -> owning app session, for fail-closed inbound routing. */
  sessionForTopic(topicId: string): string | undefined {
    for (const [sessionId, record] of Object.entries(this.loaded().topics)) {
      if (record.topicId === topicId) return sessionId;
    }
    return undefined;
  }

  /**
   * Resolves the session's topic, creating it once for the paired chat. `null`
   * means the chat rejected topic creation and the caller should send flat,
   * exactly as before.
   */
  ensureTopic(input: EnsureTopicInput): Promise<string | null> {
    const pending = this.inflight.get(input.sessionId);
    if (pending) return pending;
    const tracked = this.createTopic(input).finally(() => this.inflight.delete(input.sessionId));
    this.inflight.set(input.sessionId, tracked);
    return tracked;
  }

  private async createTopic(input: EnsureTopicInput): Promise<string | null> {
    if (!input.sessionId || !input.name.trim()) return null;
    const state = this.loaded();
    if (state.chatId && state.chatId !== input.chatId) {
      // A new pairing must not inherit topics from the previous chat.
      this.state = { version: 1, chatId: input.chatId, topics: {} };
    } else if (!state.chatId) {
      state.chatId = input.chatId;
    }

    const existing = this.loaded().topics[input.sessionId];
    if (existing) {
      if (!existing.identitySent && input.identity) {
        await this.sendIdentity(input, existing.topicId);
      }
      return existing.topicId;
    }

    const created = await callTelegramApi<{ message_thread_id?: unknown }>({
      botToken: input.botToken,
      method: 'createForumTopic',
      body: { chat_id: input.chatId, name: topicName(input.name) },
      fetchImpl: this.options.fetchImpl,
    });
    const topicId = created.ok ? String(created.result?.message_thread_id ?? '') : '';
    if (!created.ok || !isValidTopicId(topicId)) {
      if (!created.ok) console.error('[Telegram] Could not create a session topic:', created.description);
      return null;
    }

    this.loaded().topics[input.sessionId] = { topicId, name: input.name, identitySent: false };
    this.persist();
    if (input.identity) await this.sendIdentity(input, topicId);
    return topicId;
  }

  private async sendIdentity(input: EnsureTopicInput, topicId: string): Promise<void> {
    const record = this.loaded().topics[input.sessionId];
    if (!record || record.identitySent || !input.identity) return;

    const sent = await callTelegramApi<{ message_id?: unknown }>({
      botToken: input.botToken,
      method: 'sendMessage',
      body: {
        chat_id: input.chatId,
        message_thread_id: Number(topicId),
        text: input.identity,
        parse_mode: 'HTML',
        disable_notification: true,
      },
      fetchImpl: this.options.fetchImpl,
    });
    if (!sent.ok) return;

    record.identitySent = true;
    this.persist();
    const messageId = Number(sent.result?.message_id ?? 0);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      await callTelegramApi({
        botToken: input.botToken,
        method: 'pinChatMessage',
        body: { chat_id: input.chatId, message_id: messageId, disable_notification: true },
        fetchImpl: this.options.fetchImpl,
      });
    }
  }
}

let singleton: { key: string; threads: TelegramThreads } | null = null;

/** The process-wide registry; re-keyed so a moved agent directory starts clean. */
export function telegramThreads(): TelegramThreads {
  const key = path.join(telegramAgentDir(), 'notifications', 'telegram-threads.json');
  if (singleton?.key !== key) singleton = { key, threads: new TelegramThreads({ statePath: key }) };
  return singleton.threads;
}
