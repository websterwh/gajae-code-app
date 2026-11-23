import { SquarePen, Zap } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarNavigationTabsProps = {
  readonly onCreateSession: () => void;
  /** Disposable chat: it deletes itself when the next chat starts. */
  readonly onCreateQuickChat?: () => void;
  readonly t: TFunction;
};

/**
 * One primary action, and the host renders it only when a project can host a
 * conversation: with an empty workspace the empty row and the main pane
 * already carry "Add a project", and a third, disabled-looking copy of the
 * action was the "click does nothing" report.
 */
export default function SidebarNavigationTabs({
  onCreateSession,
  onCreateQuickChat,
  t,
}: SidebarNavigationTabsProps) {
  const label = t('sessions.newTask');

  return (
    <nav className="shrink-0 px-2 pb-2" aria-label={t('navigation.primary')}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="group flex h-10 min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 text-left text-[0.9375rem] font-medium text-foreground outline-hidden transition-colors hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onCreateSession}
          aria-label={label}
          title={label}
        >
          <SquarePen className="stroke-1.8 size-4.5 shrink-0 text-foreground" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
        {onCreateQuickChat ? (
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onCreateQuickChat}
            aria-label="Quick chat"
            title="Quick chat — deleted when you start another chat"
          >
            <Zap className="stroke-1.8 size-4.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </nav>
  );
}
