import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';

type ExportDownloadButtonProps = {
  /** Absolute path of the file a local command wrote, inside the project. */
  path: string;
  projectId: string;
  sessionId?: string;
};

const fileNameOf = (value: string): string => value.split(/[\\/]/u).pop() || 'export.html';

/**
 * `/export` writes an HTML file into the project the CLI ran in. Until now the
 * only way to get it was to reach into that directory; this fetches the bytes
 * through the same project-file route images already use and hands the browser
 * a download. A plain link cannot carry the auth header, so it goes through
 * `authenticatedFetch` and a blob URL.
 */
export default function ExportDownloadButton({ path, projectId, sessionId }: ExportDownloadButtonProps) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');

  const download = async () => {
    setState('busy');
    try {
      const params = new URLSearchParams({ path });
      if (sessionId) params.set('sessionId', sessionId);
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`,
      );
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);

      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileNameOf(path);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking during the click can cancel the save in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void download()}
        disabled={state === 'busy'}
        title={path}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === 'busy'
          ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          : <Download className="h-3 w-3" aria-hidden />}
        {state === 'busy' ? t('export.downloading') : t('export.download')}
      </button>
      {state === 'failed' ? <span className="text-[11px] text-destructive">{t('export.failed')}</span> : null}
    </div>
  );
}
