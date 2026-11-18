import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { downloadProjectFile } from '../../chat/view/ExportDownloadButton';
import { useProjectExports, type ProjectExportFile } from '../hooks/useProjectExports';

export type AgentSidebarExportsProps = {
  projectId?: string;
  sessionId?: string;
};

const dateOf = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
};

/**
 * The export files this project can still offer.
 *
 * The list is the server's record of what `/export` wrote, not the chat, so it
 * is unchanged by a reload and reaches exports from earlier sessions. It lists
 * only files that still exist; an empty list renders nothing at all, which is
 * also why the block can be switched off in the lane's layout controls.
 */
export default function AgentSidebarExports({ projectId, sessionId }: AgentSidebarExportsProps) {
  const { t } = useTranslation();
  const { files } = useProjectExports(projectId, sessionId);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (!projectId || files.length === 0) return null;

  const download = async (file: ProjectExportFile) => {
    setBusy(file.path);
    setFailed(null);
    try {
      await downloadProjectFile({
        projectId,
        path: file.path,
        // A session in a worktree resolves its own directory with its id.
        sessionId: sessionId ?? file.sessionId ?? undefined,
      });
    } catch {
      setFailed(file.path);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="agent-sidebar-exports" className="border-t border-border/50 px-1 pt-1 pb-2 text-xs">
      <h3 id="agent-sidebar-exports" className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
        {t('agentSidebar.exports.title')}
      </h3>
      <ul>
        {files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 px-2 py-1" title={file.path}>
            <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
            {file.at ? (
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{dateOf(file.at)}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void download(file)}
              disabled={busy !== null}
              aria-label={`${t('agentSidebar.exports.download')} ${file.name}`}
              title={t('agentSidebar.exports.download')}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === file.path
                ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                : <Download className="h-3 w-3" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
      {failed ? <p className="px-2 pt-1 text-[10px] text-destructive">{t('agentSidebar.exports.failed')}</p> : null}
    </section>
  );
}
