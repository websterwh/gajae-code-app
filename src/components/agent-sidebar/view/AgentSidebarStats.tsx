import {
  ArrowDownToLine, ArrowUpFromLine, BarChart3, Coins, Database, MessageSquareText, PieChart, type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useSessionStatus } from '../../../contexts/SessionStatusContext';
import { formatTokens } from '../../../contexts/sessionStatusSnapshot';
import { useProjectUsage } from '../hooks/useProjectUsage';

export type AgentSidebarStatsProps = {
  projectId?: string;
  /** The project, or a session's worktree inside it. */
  projectPath?: string;
};

const integer = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * What this chat is using and what this project has spent.
 *
 * Two scopes, deliberately separate. The chat's section is the runtime's own
 * `/context` figure: the tokens it reported against the window it reported,
 * with the input/output/cache split the runtime sent. It is read from the
 * session status the chat publishes, so it is there the moment a session has
 * reported a turn - not only while it is actively running, and not dependent on
 * the transcript scan behind the project totals.
 *
 * The project's section is the stats page's history narrowed to this working
 * tree: its own row plus every row beneath it, so worktree sessions count. A
 * project with no recorded usage renders no rows; cost stays a dash rather than
 * `$0.00` when no provider reported one, because zero would claim a
 * measurement.
 *
 * Nothing is invented for an unknown: a session with no reported window gets no
 * gauge, and a fresh chat with no history and no report renders nothing at all.
 */
export default function AgentSidebarStats({ projectId, projectPath }: AgentSidebarStatsProps) {
  const { t } = useTranslation();
  const status = useSessionStatus();
  const usage = useProjectUsage(projectId, projectPath);

  const contextWindow = status.contextWindow;
  const contextPercent = status.contextPercent;
  const contextTokens = status.contextTokens;
  const tokens = status.tokens;
  const hasContext = contextWindow !== undefined && contextPercent !== undefined;
  const hasBreakdown = Boolean(tokens && (
    tokens.input !== undefined || tokens.output !== undefined || tokens.cache !== undefined
  ));

  if (!hasContext && !hasBreakdown && !usage) return null;

  // The runtime clamps its own percentage; clamp again so a bad report cannot
  // draw a bar past its track.
  const percent = Math.min(100, Math.max(0, Math.round(contextPercent ?? 0)));
  const tone = percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-primary' : 'bg-foreground/70';
  const tokenWord = t('workspace.statusTab.tokens').toLowerCase();

  return (
    <section aria-labelledby="agent-sidebar-stats" className="border-t border-border/50 px-1 py-2 text-xs">
      <h3 id="agent-sidebar-stats" className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
        {t('agentSidebar.stats.title')}
      </h3>

      {hasContext && contextWindow !== undefined && (
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <PieChart className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">{t('agentSidebar.stats.context')}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('agentSidebar.stats.context')}
            className="mt-1 ml-[22px] h-1 overflow-hidden rounded-full bg-muted"
          >
            {/* Nothing is drawn for an empty context: a fresh session shows the
                track alone rather than a sliver that reads as usage. */}
            {percent > 0 && <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${percent}%` }} />}
          </div>
          <p className="mt-1 ml-[22px] text-[10px] text-muted-foreground tabular-nums">
            {contextTokens !== undefined
              ? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)}`
              : formatTokens(contextWindow)}
            {' '}
            {tokenWord}
          </p>
        </div>
      )}

      {hasBreakdown && tokens && (
        <>
          <Subheading>{t('agentSidebar.stats.thisChat')}</Subheading>
          {tokens.input !== undefined && (
            <Row icon={ArrowDownToLine} label={t('agentSidebar.stats.input')} value={formatTokens(tokens.input)} title={integer.format(tokens.input)} />
          )}
          {tokens.output !== undefined && (
            <Row icon={ArrowUpFromLine} label={t('agentSidebar.stats.output')} value={formatTokens(tokens.output)} title={integer.format(tokens.output)} />
          )}
          {tokens.cache !== undefined && (
            <Row icon={Database} label={t('agentSidebar.stats.cache')} value={formatTokens(tokens.cache)} title={integer.format(tokens.cache)} />
          )}
        </>
      )}

      {usage && (
        <>
          <Subheading>{t('agentSidebar.stats.project')}</Subheading>
          <Row
            icon={BarChart3}
            label={t('agentSidebar.stats.tokens')}
            value={formatTokens(usage.tokens)}
            title={integer.format(usage.tokens)}
          />
          <Row
            icon={MessageSquareText}
            label={t('agentSidebar.stats.turns')}
            value={formatTokens(usage.turns)}
            title={integer.format(usage.turns)}
          />
          <Row
            icon={Coins}
            label={t('agentSidebar.stats.cost')}
            value={usage.cost > 0 ? money.format(usage.cost) : '—'}
            title={usage.cost > 0 ? money.format(usage.cost) : undefined}
          />
        </>
      )}
    </section>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground/70">{children}</p>;
}

function Row({ icon: Icon, label, value, title }: { icon: LucideIcon; label: string; value: string; title?: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5" title={title}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">{value}</span>
    </div>
  );
}
