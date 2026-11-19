/**
 * The session -> Telegram topic resolution shared by event notifications and
 * the transcript stream, so both land in the same topic with the same name.
 */

import { sessionsDb } from '@/modules/database/index.js';

import { daemonOwnsTelegram } from './telegram-ownership.js';
import { readTelegramDelivery } from './telegram-settings.js';
import { formatThreadIdentity, telegramThreads } from './telegram-threads.js';

export type SessionTelegramTopic = { botToken: string; chatId: string; threadId: string };

const concise = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name) return null;
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
};

export function sessionTopicName(input: {
  sessionId?: string | null;
  provider?: string | null;
  fallback?: string | null;
  suppliedName?: string | null;
}): string {
  const stored = input.sessionId && input.provider
    ? sessionsDb.getSessionName(input.sessionId, input.provider)
    : null;
  // The CLI names a topic after the session title, falling back to the last
  // six characters of the session id ("GJC e64b37"). Match that.
  return concise(input.suppliedName)
    ?? concise(stored)
    ?? concise(input.fallback)
    ?? (input.sessionId ? `GJC ${input.sessionId.slice(-6)}` : 'Gajae Code');
}

/**
 * Resolves the topic for a session, creating it once for the paired chat.
 * `null` means the chat rejected topic creation (or delivery is off), so
 * callers send flat or skip entirely.
 */
export async function ensureSessionTelegramTopic(input: {
  sessionId: string;
  provider?: string | null;
  fallback?: string | null;
  suppliedName?: string | null;
}): Promise<SessionTelegramTopic | null> {
  // The daemon owns the bot in native mode: it creates the topic and sends the
  // frames, so an app-side topic here would be a duplicate.
  if (daemonOwnsTelegram()) return null;
  const credentials = readTelegramDelivery();
  if (!credentials) return null;

  const row = sessionsDb.getSessionById(input.sessionId);
  const name = sessionTopicName(input);
  const threadId = await telegramThreads().ensureTopic({
    sessionId: input.sessionId,
    name,
    botToken: credentials.botToken,
    chatId: credentials.chatId,
    identity: formatThreadIdentity({
      title: name,
      sessionId: input.sessionId,
      projectPath: row?.project_path ?? null,
    }),
  });
  return threadId ? { ...credentials, threadId } : null;
}
