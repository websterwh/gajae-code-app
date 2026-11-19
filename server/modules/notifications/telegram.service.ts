/**
 * Bot API calls for app-session notifications. The CLI owns its own daemon for
 * CLI sessions; the app sends for itself because an app session is not an
 * eligible CLI host.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

const DEFAULT_TIMEOUT_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 40_000;

export type TelegramSendResult = {
  ok: boolean;
  description: string;
};

export type TelegramApiResult<T> = { ok: true; result: T } | { ok: false; description: string };

const describeFailure = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Telegram did not answer in time';
    return error.message || 'Telegram could not be reached';
  }
  return 'Telegram could not be reached';
};

/** One Bot API method call; failures come back as data so callers can fall back instead of throwing. */
export async function callTelegramApi<T>(options: {
  botToken: string;
  method: string;
  body?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TelegramApiResult<T>> {
  const send = options.fetchImpl ?? fetch;
  try {
    const response = await send(`${TELEGRAM_API_BASE}/bot${options.botToken}/${options.method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: T } | null;
    if (response.ok && payload?.ok) return { ok: true, result: payload.result as T };
    return { ok: false, description: payload?.description || `Telegram answered ${response.status}` };
  } catch (error) {
    return { ok: false, description: describeFailure(error) };
  }
}

export async function sendTelegramMessage(options: {
  botToken: string;
  chatId: string;
  text: string;
  /** Forum topic the message belongs to, when the chat supports topics. */
  messageThreadId?: number | string;
  parseMode?: 'HTML';
  disableNotification?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TelegramSendResult> {
  const body: Record<string, unknown> = {
    chat_id: options.chatId,
    text: options.text,
    disable_web_page_preview: true,
  };
  if (options.messageThreadId !== undefined) body.message_thread_id = Number(options.messageThreadId);
  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.disableNotification === true) body.disable_notification = true;

  const result = await callTelegramApi<unknown>({
    botToken: options.botToken,
    method: 'sendMessage',
    body,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return result.ok ? { ok: true, description: '' } : { ok: false, description: result.description };
}

export type TelegramBotUpdate = {
  update_id?: unknown;
  message?: {
    message_id?: unknown;
    text?: unknown;
    from?: { id?: unknown; is_bot?: unknown };
    chat?: { id?: unknown };
    message_thread_id?: unknown;
  };
};

/** Long-polls `getUpdates`; the poll timeout is longer than the server-side wait. */
export async function fetchTelegramUpdates(options: {
  botToken: string;
  offset: number;
  timeoutSeconds: number;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<TelegramApiResult<TelegramBotUpdate[]>> {
  const send = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
  const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
  try {
    const response = await send(`${TELEGRAM_API_BASE}/bot${options.botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: options.offset,
        timeout: options.timeoutSeconds,
        allowed_updates: ['message'],
      }),
      signal,
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: TelegramBotUpdate[] } | null;
    if (response.ok && payload?.ok && Array.isArray(payload.result)) return { ok: true, result: payload.result };
    return { ok: false, description: payload?.description || `Telegram answered ${response.status}` };
  } catch (error) {
    return { ok: false, description: describeFailure(error) };
  }
}
