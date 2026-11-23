import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';

type GitAction = 'fetch' | 'pull' | 'push' | 'commit';
type ScopePayload = {
  success?: boolean;
  connected?: boolean;
  scopes?: unknown;
  fineGrained?: boolean;
};

const WRITE_SCOPES = ['repo', 'public_repo'];

/**
 * A fine-grained token exposes no scope header, so its permissions cannot be
 * introspected here; a connected one is treated as able rather than hiding a
 * button the token may well have the right to use. Classic tokens must carry
 * `repo` (or `public_repo`), because a read-only token would fail every action.
 */
function allowsWrite(payload: ScopePayload): boolean {
  if (payload.success !== true || payload.connected !== true) return false;
  if (payload.fineGrained === true) return true;
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  return scopes.some((scope) => WRITE_SCOPES.includes(scope));
}

/**
 * The lane's Git commands: fetch, pull, push and commit.
 *
 * The block is absent unless the saved GitHub token can write to a repository,
 * so a read-only or missing token never offers a button that is guaranteed to
 * fail. The actions run against the project's own checkout, not a session
 * worktree, which is the repository the remote belongs to. Staging is not one
 * of the buttons: Commit commits what is already staged, so nothing is added
 * behind the reader's back.
 */
export default function AgentSidebarGit({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState<GitAction | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/user/github-token/scopes');
        if (!response.ok) return;
        const payload = (await response.json()) as ScopePayload;
        if (!cancelled) setAllowed(allowsWrite(payload));
      } catch {
        // No saved token or no network: the block stays absent.
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const run = useCallback(async (action: GitAction, body: Record<string, unknown> = {}) => {
    if (!projectId) return;
    setBusy(action);
    setResult(null);
    try {
      const response = await authenticatedFetch(`/api/git/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectId, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        output?: string;
        error?: string;
        details?: string;
      };
      if (!response.ok || payload.success === false) {
        setResult({ ok: false, text: payload.details || payload.error || t('agentSidebar.git.failed') });
        return;
      }
      if (action === 'commit') {
        setMessage('');
        setComposing(false);
      }
      setResult({ ok: true, text: payload.output || t('agentSidebar.git.done') });
      window.dispatchEvent(new Event('gajae:git-changed'));
    } catch {
      setResult({ ok: false, text: t('agentSidebar.git.failed') });
    } finally {
      setBusy(null);
    }
  }, [projectId, t]);

  if (!projectId || !allowed) return null;

  const buttonClassName = 'flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <section aria-labelledby="agent-sidebar-git" className="border-t border-border/50 px-1 pt-1 pb-2 text-xs">
      <h3 id="agent-sidebar-git" className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
        {t('agentSidebar.git.title')}
      </h3>
      <div className="flex flex-wrap gap-1 px-2 py-1">
        <button type="button" className={buttonClassName} disabled={busy !== null} onClick={() => void run('fetch')} title={t('agentSidebar.git.fetch')}>
          {busy === 'fetch' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <ArrowDownToLine className="h-3 w-3" aria-hidden />}
          {t('agentSidebar.git.fetch')}
        </button>
        <button type="button" className={buttonClassName} disabled={busy !== null} onClick={() => void run('pull')} title={t('agentSidebar.git.pull')}>
          {busy === 'pull' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <ArrowDownToLine className="h-3 w-3" aria-hidden />}
          {t('agentSidebar.git.pull')}
        </button>
        <button type="button" className={buttonClassName} disabled={busy !== null} onClick={() => void run('push')} title={t('agentSidebar.git.push')}>
          {busy === 'push' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <ArrowUpFromLine className="h-3 w-3" aria-hidden />}
          {t('agentSidebar.git.push')}
        </button>
        <button
          type="button"
          className={buttonClassName}
          disabled={busy !== null}
          aria-expanded={composing}
          onClick={() => { setComposing((value) => !value); setResult(null); }}
          title={t('agentSidebar.git.commit')}
        >
          {busy === 'commit' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <GitCommitHorizontal className="h-3 w-3" aria-hidden />}
          {t('agentSidebar.git.commit')}
        </button>
      </div>
      {composing && (
        <form
          className="px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void run('commit', { message });
          }}
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t('agentSidebar.git.messagePlaceholder')}
            aria-label={t('agentSidebar.git.message')}
            className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-hidden focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={busy !== null || message.trim() === ''}
            className="mt-1 w-full rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'commit' ? t('agentSidebar.git.busy') : t('agentSidebar.git.submit')}
          </button>
        </form>
      )}
      {result && (
        <p
          title={result.text}
          className={`truncate px-2 pt-1 text-[10px] ${result.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {result.text}
        </p>
      )}
    </section>
  );
}
