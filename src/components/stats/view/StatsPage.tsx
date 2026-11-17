import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BarChart3, Boxes, Coins, MessageSquareText, RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { api } from '../../../utils/api';

type Totals = {
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

type ModelRow = Totals & { model: string; provider: string };
type ProjectRow = Totals & { name: string; path: string; lastActiveAt: string | null };
type DayRow = { date: string; total: number; cost: number };

type Overview = {
  generatedAt: string;
  root: string;
  scanned: { files: number; bytes: number; truncated: boolean };
  totals: Totals;
  models: ModelRow[];
  projects: ProjectRow[];
  daily: DayRow[];
  firstActivityAt: string | null;
  lastActivityAt: string | null;
};

const integer = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const dateLabel = (iso: string) => {
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const BAR_DAYS = 30;
const CALENDAR_WEEKS = 26;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const ACTIVITY_TONES = ['bg-muted/60', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary'];

/**
 * The API only returns days that saw traffic, so inactive days would silently
 * compress a chart. The window is rebuilt here with zero-total days.
 */
function lastDays(daily: DayRow[], count: number): DayRow[] {
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, total: 0, cost: 0 };
  });
}

/**
 * Columns are weeks and rows are weekdays, Sunday first. Starting on the Sunday
 * 25 weeks back keeps every column full so the squares span the card; days after
 * today are padded blank.
 */
function calendarWeeks(daily: DayRow[]): (DayRow | null)[][] {
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(today).getUTCDay();
  const start = today - (weekday + (CALENDAR_WEEKS - 1) * 7) * DAY_MS;
  return Array.from({ length: CALENDAR_WEEKS }, (_, week) => Array.from({ length: 7 }, (_, day): DayRow | null => {
    const time = start + (week * 7 + day) * DAY_MS;
    if (time > today) return null;
    const date = new Date(time).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, total: 0, cost: 0 };
  }));
}

function activityLevel(total: number, busiest: number): number {
  if (total <= 0 || busiest <= 0) return 0;
  return Math.min(ACTIVITY_TONES.length - 1, Math.ceil((total / busiest) * (ACTIVITY_TONES.length - 1)));
}

type DayHover = { date: string; total: number; x: number; y: number };

function MetricCard({ icon: Icon, label, value, hint }: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 text-xl font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * One row of the token breakdown. The share is drawn against the whole rather
 * than normalised to the largest slice, so an output of 20k next to 4M of cache
 * reads still reads as the sliver it is.
 */
function BreakdownRow({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const share = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground tabular-nums">{integer.format(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="mt-4 rounded-xl border border-border/70 bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default function StatsPage() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hoveredDay, setHoveredDay] = useState<DayHover | null>(null);
  const [hoverTipLeft, setHoverTipLeft] = useState(0);
  const hoverTip = useRef<HTMLDivElement | null>(null);
  const daily = overview?.daily;
  const activityDays = useMemo(() => lastDays(daily ?? [], BAR_DAYS), [daily]);
  const weeks = useMemo(() => calendarWeeks(daily ?? []), [daily]);
  const calendarDays = useMemo(() => weeks.flat().filter((day): day is DayRow => day !== null), [weeks]);
  const calendarBusiest = useMemo(() => Math.max(0, ...calendarDays.map((day) => day.total)), [calendarDays]);
  const barBusiest = useMemo(() => Math.max(0, ...activityDays.map((day) => day.total)), [activityDays]);

  const load = useCallback(async (refresh: boolean) => {
    setStatus((previous) => (previous === 'ready' ? previous : 'loading'));
    try {
      const response = await api.statsOverview(refresh);
      if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
      const payload = await response.json() as { data?: Overview };
      if (!payload.data) throw new Error('Usage response carried no data');
      setOverview(payload.data);
      setStatus('ready');
    } catch (error) {
      console.error('[Stats] Failed to load usage:', error);
      setStatus('error');
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const showDay = (day: DayRow) => (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoveredDay({ date: day.date, total: day.total, x: rect.left + rect.width / 2, y: rect.top - 8 });
  };

  // The tooltip is measured before paint so an edge cell's box is nudged inward
  // without ever appearing half off screen first.
  useLayoutEffect(() => {
    if (!hoveredDay || !hoverTip.current) return;
    const width = hoverTip.current.offsetWidth;
    const margin = 8;
    setHoverTipLeft(width + margin * 2 >= window.innerWidth
      ? window.innerWidth / 2
      : Math.min(Math.max(hoveredDay.x, margin + width / 2), window.innerWidth - margin - width / 2));
  }, [hoveredDay]);

  const totals = overview?.totals;
  const pinnedCost = overview && overview.totals.cost > 0;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto w-full max-w-4xl px-5 py-7 sm:px-8">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Button
              variant="ghost"
              size="sm"
              className="mt-0.5 size-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              onClick={() => navigate('/')}
              aria-label={t('stats.back', 'Back to chat')}
              title={t('stats.back', 'Back to chat')}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">{t('stats.title', 'Usage')}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t('stats.subtitle', 'What every Gajae session on this machine has spent.')}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={() => { void load(true); }}
            disabled={status === 'loading'}
            aria-label={t('stats.refresh', 'Recount usage')}
            title={t('stats.refresh', 'Recount usage')}
          >
            <RefreshCw className={status === 'loading' ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </div>

        {status === 'error' && (
          <div className="mt-6 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p>{t('stats.loadError', 'Could not read the session transcripts.')}</p>
              <button type="button" className="mt-1 underline underline-offset-2" onClick={() => { void load(true); }}>
                {t('stats.retry', 'Try again')}
              </button>
            </div>
          </div>
        )}

        {status === 'loading' && !overview && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-xl border border-border/70 bg-muted/40" />
            ))}
          </div>
        )}

        {totals && totals.sessions === 0 && (
          <div className="mt-6 rounded-xl border border-border/70 bg-card p-6 text-center">
            <BarChart3 className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <p className="mt-2 text-sm font-medium text-foreground">{t('stats.emptyTitle', 'No usage recorded yet')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('stats.emptyBody', 'Numbers appear here once a conversation has produced at least one response.')}
            </p>
          </div>
        )}

        {totals && totals.sessions > 0 && overview && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard
                icon={BarChart3}
                label={t('stats.totalTokens', 'Total tokens')}
                value={compact.format(totals.total)}
                hint={integer.format(totals.total)}
              />
              <MetricCard
                icon={MessageSquareText}
                label={t('stats.turns', 'Turns')}
                value={compact.format(totals.turns)}
                hint={t('stats.sessionsHint', '{{count}} sessions', { count: totals.sessions })}
              />
              <MetricCard
                icon={Boxes}
                label={t('stats.output', 'Output tokens')}
                value={compact.format(totals.output)}
                hint={t('stats.inputHint', '{{count}} input tokens', { count: totals.input })}
              />
              <MetricCard
                icon={Coins}
                label={t('stats.cost', 'Recorded cost')}
                value={pinnedCost ? money.format(totals.cost) : '—'}
                hint={t('stats.costHint', 'Sum of reported per-turn cost')}
              />
            </div>

            <Section
              title={t('stats.breakdown', 'Where the tokens went')}
              subtitle={t('stats.breakdownHint', 'Cached input is counted separately from fresh input, as the providers report it.')}
            >
              <div className="space-y-3">
                <BreakdownRow label={t('stats.input', 'Input')} value={totals.input} total={totals.total} tone="bg-primary" />
                <BreakdownRow label={t('stats.output', 'Output')} value={totals.output} total={totals.total} tone="bg-primary/55" />
                <BreakdownRow label={t('stats.cacheRead', 'Cache read')} value={totals.cacheRead} total={totals.total} tone="bg-muted-foreground/50" />
                <BreakdownRow label={t('stats.cacheWrite', 'Cache write')} value={totals.cacheWrite} total={totals.total} tone="bg-muted-foreground/30" />
              </div>
            </Section>

            {overview.daily.length > 0 && (
              <>
                <Section
                  title={t('stats.activityCalendar', 'Last 6 months')}
                  subtitle={t('stats.activityGridHint', 'One square per day; darker squares mean more tokens.')}
                >
                  <div
                    role="img"
                    aria-label={t('stats.activityAria', 'Daily token usage')}
                    data-view="grid"
                    onMouseLeave={() => setHoveredDay(null)}
                  >
                    <div
                      className="grid grid-flow-col grid-rows-7 gap-0.5 sm:gap-1"
                      style={{ gridTemplateColumns: `auto repeat(${CALENDAR_WEEKS}, minmax(0, 1fr))` }}
                    >
                      {WEEKDAY_LABELS.map((label, index) => (
                        <span
                          key={`weekday-${index}`}
                          className="flex items-center justify-end pr-1.5 text-[10px] leading-none text-muted-foreground"
                          aria-hidden
                        >
                          {label}
                        </span>
                      ))}
                      {weeks.map((week, weekIndex) => week.map((day, dayIndex) => (day ? (
                        <div
                          key={day.date}
                          data-date={day.date}
                          onMouseEnter={showDay(day)}
                          className={`aspect-square w-full rounded-[3px] border border-border/40 transition-colors hover:border-foreground/30 ${ACTIVITY_TONES[activityLevel(day.total, calendarBusiest)]}`}
                        />
                      ) : (
                        <div key={`empty-${weekIndex}-${dayIndex}`} className="aspect-square w-full" aria-hidden />
                      ))))}
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                      <span>{dateLabel(calendarDays[0].date)}</span>
                      <span>{dateLabel(calendarDays[calendarDays.length - 1].date)}</span>
                    </div>
                  </div>
                </Section>

                <Section
                  title={t('stats.activity', 'Last 30 days')}
                  subtitle={t('stats.activityHint', 'Tokens per day, newest on the right.')}
                >
                  <div
                    className="flex h-28 items-end gap-1"
                    role="img"
                    aria-label={t('stats.activityAria', 'Daily token usage')}
                    data-view="bars"
                    onMouseLeave={() => setHoveredDay(null)}
                  >
                    {activityDays.map((day) => (
                      <div key={day.date} data-date={day.date} className="group flex h-full min-w-0 flex-1 items-end" onMouseEnter={showDay(day)}>
                        <div
                          className={`w-full rounded-t-sm transition-colors ${day.total > 0 ? 'bg-primary/70 group-hover:bg-primary' : 'bg-muted/70'}`}
                          style={{ height: `${barBusiest > 0 ? Math.max(3, (day.total / barBusiest) * 100) : 3}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                    <span>{dateLabel(activityDays[0].date)}</span>
                    <span>{dateLabel(activityDays[activityDays.length - 1].date)}</span>
                  </div>
                </Section>
              </>
            )}

            {overview.models.length > 0 && (
              <Section title={t('stats.models', 'By model')}>
                <div className="space-y-2">
                  {overview.models.map((row) => (
                    <div key={`${row.provider}:${row.model}`} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <div className="truncate text-foreground">{row.model}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {row.provider} · {t('stats.modelSessions', '{{count}} sessions', { count: row.sessions })}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-foreground tabular-nums">{integer.format(row.total)}</div>
                        {row.cost > 0 && <div className="text-[11px] text-muted-foreground tabular-nums">{money.format(row.cost)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {overview.projects.length > 0 && (
              <Section title={t('stats.projects', 'By workspace')}>
                <div className="space-y-2">
                  {overview.projects.map((row) => (
                    <div key={row.path} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <div className="truncate text-foreground">{row.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground" title={row.path}>{row.path}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-foreground tabular-nums">{integer.format(row.total)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {row.lastActiveAt ? dateLabel(row.lastActiveAt) : t('stats.unknownDate', 'unknown')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
              {t('stats.footnote', 'Read from {{files}} transcripts on this machine.', { files: overview.scanned.files })}
              {overview.scanned.truncated && ` ${t('stats.truncated', 'The scan stopped at its size limit, so these totals are partial.')}`}
              {overview.lastActivityAt && ` ${t('stats.lastActivity', 'Last activity {{date}}.', { date: dateLabel(overview.lastActivityAt) })}`}
            </p>
          </>
        )}
      </div>

      {hoveredDay && (
        <div
          ref={hoverTip}
          style={{ left: hoverTipLeft, top: hoveredDay.y }}
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium whitespace-nowrap text-popover-foreground shadow-lg"
        >
          {dateLabel(hoveredDay.date)} · {integer.format(hoveredDay.total)} {t('stats.tokens', 'tokens')}
        </div>
      )}
    </div>
  );
}
