import { useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import { repositoryRootOf } from '../utils/environmentLabels';

export type ProjectUsage = {
  tokens: number;
  turns: number;
  sessions: number;
  cost: number;
};

type ProjectRow = { path: string; total: number; turns: number; sessions: number; cost: number };

/**
 * The usage totals for the project this lane is showing, from the same
 * overview the stats page renders.
 *
 * The overview groups transcripts by the directory they ran in, and a session
 * in a worktree records `<repo>/.gjc-worktrees/…` as its directory, so the
 * project is its own row plus every row beneath it. Anything outside that path
 * is another project's spending and is not summed here.
 */
export function useProjectUsage(projectId?: string, projectPath?: string) {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);

  useEffect(() => {
    if (!projectId || !projectPath) {
      setUsage(null);
      return undefined;
    }

    const root = repositoryRootOf(projectPath);
    let cancelled = false;

    void api.statsOverview()
      .then(async (response) => (
        response.ok ? await response.json() as { data?: { projects?: ProjectRow[] } } : null
      ))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = (body.data?.projects ?? []).filter((row) => (
          row.path === root || row.path.startsWith(`${root}/`)
        ));
        if (rows.length === 0) {
          setUsage(null);
          return;
        }
        setUsage(rows.reduce<ProjectUsage>((sum, row) => ({
          tokens: sum.tokens + row.total,
          turns: sum.turns + row.turns,
          sessions: sum.sessions + row.sessions,
          cost: sum.cost + row.cost,
        }), { tokens: 0, turns: 0, sessions: 0, cost: 0 }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projectId, projectPath]);

  return usage;
}
