import { Settings, PanelLeftOpen, Bug } from 'lucide-react';
import type { TFunction } from 'i18next';

import SidebarDesktopUpdate from './SidebarDesktopUpdate';
import SidebarProviderQuota from './SidebarProviderQuota';

const GITHUB_ISSUES_URL = 'https://github.com/websterwh/gajae-code-app/issues/new';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarCollapsed({
  onExpand,
  onShowSettings,
  t,
}: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-sidebar py-3">
      {/* Expand button with brand logo */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <div className="mt-auto flex flex-col items-center gap-1">
        <div className="my-1 nav-divider w-6" />

        <SidebarDesktopUpdate collapsed onExpand={onExpand} />

        <SidebarProviderQuota collapsed t={t} />

        {/* Settings */}
        <button
          onClick={onShowSettings}
          className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('actions.settings')}
          title={t('actions.settings')}
        >
          <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>

        {/* Report Issue */}
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('actions.reportIssue')}
          title={t('actions.reportIssue')}
        >
          <Bug className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
        </a>


      </div>

    </div>
  );
}
