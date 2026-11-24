import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';

import { Markdown } from './Markdown';

type BtwExchange = { question: string; answer: string };

interface BtwPanelProps {
  question: string;
  sessionId: string | null;
  onClose: () => void;
}

type BtwStreamEvent =
  | { type: 'delta'; text?: unknown }
  | { type: 'done'; text?: unknown }
  | { type: 'error'; message?: unknown };

/**
 * CLI `/btw`: a temporary side chat over the current conversation.
 *
 * The main transcript is never a participant here. Each question is its own
 * server run using the runtime's ephemeral turn, and completed exchanges stay
 * in this component until the drawer closes. Esc closes and discards it, as
 * the TUI panel does.
 */
export default function BtwPanel({ question, sessionId, onClose }: BtwPanelProps) {
  const { t } = useTranslation('chat');
  const [exchanges, setExchanges] = useState<BtwExchange[]>([]);
  const [asked, setAsked] = useState(question);
  const [answer, setAnswer] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [error, setError] = useState('');
  const [thinking, setThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const started = useRef(false);

  const close = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const sendQuestion = async (text: string, history: BtwExchange[]) => {
    if (!sessionId) {
      setError(t('btw.error', { defaultValue: 'Side chat failed.' }));
      return;
    }
    setAsked(text);
    setAnswer('');
    setError('');
    setThinking(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = '';
    try {
      const response = await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/btw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, exchanges: history }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
        const value = payload?.error ?? payload?.message;
        const message = typeof value === 'string'
          ? value
          : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
            ? value.message
            : `Request failed (${response.status})`;
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').find((line) => line.startsWith('data:'));
          if (data) {
            const event = JSON.parse(data.slice(5).trim()) as BtwStreamEvent;
            if (event.type === 'delta' && typeof event.text === 'string') {
              streamed += event.text;
              setAnswer(streamed);
            } else if (event.type === 'done') {
              const finalText = typeof event.text === 'string' ? event.text : streamed;
              finished = true;
              setExchanges([...history, { question: text, answer: finalText }]);
              setAnswer('');
            } else if (event.type === 'error') {
              finished = true;
              throw new Error(typeof event.message === 'string' ? event.message : t('btw.error', { defaultValue: 'Side chat failed.' }));
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!finished) throw new Error(t('btw.error', { defaultValue: 'Side chat failed.' }));
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : t('btw.error', { defaultValue: 'Side chat failed.' }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setThinking(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void sendQuestion(question, []);
    // The drawer is mounted for one side chat; the first question is its start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const currentVisible = thinking || answer.length > 0 || error.length > 0;

  return (
    <aside
      aria-label={t('btw.title', { defaultValue: 'Side chat' })}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('btw.title', { defaultValue: 'Side chat' })}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('btw.hint', { defaultValue: 'Ask about this conversation without changing it.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={t('btw.close', { defaultValue: 'Close side chat' })}
          title={t('btw.close', { defaultValue: 'Close side chat' })}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {exchanges.map((exchange, index) => (
          <div key={`${index}:${exchange.question}`} className="space-y-2">
            <p className="ml-6 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{exchange.question}</p>
            <Markdown className="prose prose-sm max-w-none dark:prose-invert [&_pre]:max-w-none [&_table]:max-w-none">
              {exchange.answer}
            </Markdown>
          </div>
        ))}
        {currentVisible && (
          <div className="space-y-2">
            <p className="ml-6 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{asked}</p>
            {answer.length > 0 && (
              <Markdown className="prose prose-sm max-w-none dark:prose-invert [&_pre]:max-w-none [&_table]:max-w-none">
                {answer}
              </Markdown>
            )}
            {thinking && answer.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('btw.thinking', { defaultValue: 'Thinking…' })}</p>
            )}
            {error.length > 0 && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const text = followUp.trim();
          if (!text || thinking) return;
          setFollowUp('');
          void sendQuestion(text, exchanges);
        }}
      >
        <textarea
          value={followUp}
          onChange={(event) => setFollowUp(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          placeholder={t('btw.placeholder', { defaultValue: 'Ask a side question…' })}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-hidden focus:ring-2 focus:ring-ring"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={thinking || !followUp.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('btw.send', { defaultValue: 'Send' })}
          </button>
        </div>
      </form>
    </aside>
  );
}
