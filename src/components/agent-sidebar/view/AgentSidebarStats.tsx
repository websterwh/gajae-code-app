import { BarChart3, Coins, MessageSquareText, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectUsage } from '../hooks/useProjectUsage';

export type AgentSidebarStatsProps = {
  projectId?: string;
  /** The project, or a session's worktree inside it. */
  projectPath?: string;
};

const integer = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * What this project has spent, at a glance: the stats page's numbers narrowed
 * to one working tree.
 *
 * Only the three totals that fit a lane are shown - tokens, turns, cost - and a
 * project with no recorded usage renders nothing at all, the same rule the WORK
 * and exports blocks follow. Cost is left as a dash rather than `$0.00` when no
 * provider reported one, because zero would claim a measurement.
 */
export default function AgentSidebarStats({ projectId, projectPath }: AgentSidebarStatsProps) {
  const { t } = useTranslation();
  const usage = useProjectUsage(projectId, projectPath);

  if (!usage) return null;

  return (
    <section aria-labelledby="agent-sidebar-stats" className="border-t border-border/50 px-1 py-2 text-xs">
      <h3 id="agent-sidebar-stats" className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
        {t('agentSidebar.stats.title')}
      </h3>
      <Row icon={BarChart3} title={integer.format(usage.tokens)}>
        {t('agentSidebar.stats.tokens')}
        <span className="float-right text-muted-foreground tabular-nums">{compact.format(usage.tokens)}</span>
      </Row>
      <Row icon={MessageSquareText} title={integer.format(usage.turns)}>
        {t('agentSidebar.stats.turns')}
        <span className="float-right text-muted-foreground tabular-nums">{compact.format(usage.turns)}</span>
      </Row>
      <Row icon={Coins} title={usage.cost > 0 ? money.format(usage.cost) : undefined}>
        {t('agentSidebar.stats.cost')}
        <span className="float-right text-muted-foreground tabular-nums">
          {usage.cost > 0 ? money.format(usage.cost) : '—'}
        </span>
      </Row>
    </section>
  );
}

function Row({ icon: Icon, title, children }: { icon: LucideIcon; title?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5" title={title}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{children}</span>
    </div>
  );
}
