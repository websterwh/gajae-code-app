/**
 * One Bot API call, for the settings page's test button. The CLI owns the real
 * delivery path; this exists so the form can prove a token and chat id work
 * before a run depends on them.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

const DEFAULT_TIMEOUT_MS = 10_000;

export type TelegramSendResult = {
  ok: boolean;
  description: string;
};

const describeFailure = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Telegram did not answer in time';
    return error.message || 'Telegram could not be reached';
  }
  return 'Telegram could not be reached';
};

export async function sendTelegramMessage(options: {
  botToken: string;
  chatId: string;
  text: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TelegramSendResult> {
  const send = options.fetchImpl ?? fetch;
  try {
    const response = await send(`${TELEGRAM_API_BASE}/bot${options.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: options.chatId,
        text: options.text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (response.ok && payload?.ok) return { ok: true, description: '' };
    return { ok: false, description: payload?.description || `Telegram answered ${response.status}` };
  } catch (error) {
    return { ok: false, description: describeFailure(error) };
  }
}
