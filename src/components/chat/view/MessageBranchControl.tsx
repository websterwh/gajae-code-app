import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../stores/usePaletteOpsStore';
import { authenticatedFetch } from '../../../utils/api';

/**
 * Edit a prompt again, in a branch.
 *
 * A message id is the transcript entry id the branch is taken at, so editing a
 * prompt is the same step `/tree` performs: the server calls the SDK's
 * `createBranchedSession(entryId)` and registers a session whose history ends
 * just before this prompt. The edited text is left in that session's composer
 * draft rather than sent here, because this turn was never part of it.
 */
const MessageBranchControl = ({
  sessionId,
  entryId,
  content,
}: {
  sessionId: string;
  entryId: string;
  content: string;
}) => {
  const { t } = useTranslation('chat');
  const palette = usePaletteOps();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const branch = async () => {
    if (busy || !entryId || !sessionId) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(sessionId)}/branch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId }),
        },
      );
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = await response.json() as { data?: { sessionId?: string } };
      const created = body?.data?.sessionId;
      if (!created) {
        setFailed(true);
        return;
      }
      // The composer reads this key when the branch is opened, so the edited
      // prompt is already waiting there.
      try {
        localStorage.setItem(`draft_input_session_${created}`, draft);
      } catch {
        // Storage may be unavailable; the branch itself is still created.
      }
      await palette.refreshProjects();
      palette.openSessionPicker();
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const label = t('branchMessage.edit', { defaultValue: 'Edit in a new branch' });

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(content); setFailed(false); setEditing(true); }}
        title={label}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-primary-foreground/80 transition-colors hover:text-primary-foreground"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="pointer-events-auto mt-2 w-full rounded-lg border border-border bg-background p-2 text-left shadow-sm">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={label}
        rows={3}
        className="w-full resize-y rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-none"
      />
      {failed && (
        <p className="mt-1 text-[11px] text-destructive">
          {t('branchMessage.failed', { defaultValue: 'The branch could not be created.' })}
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t('branchMessage.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void branch(); }}
          className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy
            ? t('branchMessage.branching', { defaultValue: 'Branching…' })
            : t('branchMessage.branch', { defaultValue: 'Branch from here' })}
        </button>
      </div>
    </div>
  );
};

export default MessageBranchControl;
