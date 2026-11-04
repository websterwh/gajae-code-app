import { Archive, Bug, RefreshCw, Settings } from 'lucide-react';
import type { TFunction } from 'i18next';

import { GITHUB_ISSUES_URL, GITHUB_REPOSITORY_URL } from '../../../constants/branding';

import SidebarDesktopUpdate from './SidebarDesktopUpdate';
import SidebarProviderQuota from './SidebarProviderQuota';


type SidebarFooterProps = {
  currentVersion: string;
  onOpenArchive: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  currentVersion,
  onOpenArchive,
  onRefresh,
  isRefreshing,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const utilityClassName = 'flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <footer className="shrink-0 px-2 pb-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
      <div className="mb-1 h-px bg-border/50" />
      <SidebarDesktopUpdate />
      <SidebarProviderQuota t={t} />
      <button
        type="button"
        className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onShowSettings}
      >
        <Settings className="size-4" aria-hidden />
        <span>{t('actions.settings')}</span>
      </button>

      <div className="flex items-center justify-between px-1 pt-0.5">
        <div className="flex items-center gap-0.5">
          <button className={utilityClassName} onClick={onOpenArchive} aria-label={t('archived.openArchive', 'Open archive')} title={t('archived.openArchive', 'Open archive')}>
            <Archive className="size-4" />
          </button>
          <button className={utilityClassName} onClick={onRefresh} disabled={isRefreshing} aria-label={t('tooltips.refresh')} title={t('tooltips.refresh')}>
            <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <a className={utilityClassName} href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" aria-label={t('actions.reportIssue')} title={t('actions.reportIssue')}>
            <Bug className="size-4" />
          </a>

        </div>
        <a
          href={GITHUB_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded px-1 text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          title={`Gajae Code App v${currentVersion}`}
        >
          v{currentVersion}
        </a>
      </div>
    </footer>
  );
}
