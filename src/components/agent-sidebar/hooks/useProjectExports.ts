import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type ProjectExportFile = {
  /** Absolute path inside the session's workspace. */
  path: string;
  name: string;
  sessionId: string | null;
  at: string;
};

/**
 * The files `/export` wrote for this project.
 *
 * The server keeps the record, so the list is the same after a reload or in a
 * fresh tab. A short poll picks up an export the moment the worker writes it;
 * a failed poll keeps the previous list rather than emptying the lane.
 */
export function useProjectExports(projectId?: string, sessionId?: string) {
  const [files, setFiles] = useState<ProjectExportFile[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!projectId) {
      setFiles([]);
      return undefined;
    }

    const controller = new AbortController();
    const load = async () => {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      const query = params.toString();
      try {
        const response = await authenticatedFetch(
          `/api/projects/${encodeURIComponent(projectId)}/exports${query ? `?${query}` : ''}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = await response.json() as { data?: ProjectExportFile[] };
        if (!controller.signal.aborted) setFiles(Array.isArray(body.data) ? body.data : []);
      } catch {
        // A poll that failed (offline, restarting server) leaves the last list.
      }
    };

    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [projectId, sessionId, reloadKey]);

  return { files, refresh };
}
