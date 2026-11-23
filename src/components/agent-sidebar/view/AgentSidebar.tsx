import { Fragment, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionStore } from '../../../stores/useSessionStore';
import {
  DEFAULT_AGENT_SIDEBAR_LAYOUT,
  type AgentSidebarBlock,
  type AgentSidebarLayoutEntry,
} from '../agentSidebarState';

import AgentSidebarEnvironment, { type AgentSidebarEnvironmentProps } from './AgentSidebarEnvironment';
import AgentSidebarGit from './AgentSidebarGit';
import AgentSidebarExports from './AgentSidebarExports';
import AgentSidebarLayoutPanel from './AgentSidebarLayoutPanel';
import AgentSidebarStats from './AgentSidebarStats';
import AgentSidebarWork from './AgentSidebarWork';
import AgentSidebarActionRequired from './AgentSidebarActionRequired';

export type AgentSidebarProps = AgentSidebarEnvironmentProps & {
  isMobile: boolean;
  /** Dismisses the mobile drawer; desktop is shown and hidden from the header toggle. */
  onClose: () => void;
  /** The chat's session store; the WORK block reads the todo fold from the window the transcript uses. */
  sessionStore: SessionStore;
  /** Block order and visibility; defaults to every block, exports last. */
  blocks?: AgentSidebarLayoutEntry[];
  onToggleBlock?: (block: AgentSidebarBlock) => void;
  onMoveBlock?: (block: AgentSidebarBlock, toIndex: number) => void;
};

/**
 * The production right-hand surface: a context lane beside the conversation.
 *
 * On desktop it is a fixed-width column with no border, background, header or
 * resize handle of its own, holding one compact card: the Environment summary,
 * the chat's context and the project's recorded usage, the WORK block while the
 * session has a todo list or is running, Action required while a request awaits
 * an answer, and the persistent list of exports the project can hand back. The reader chooses which of those blocks
 * are shown and in what order with the pencil in the lane's bottom-right
 * corner; that layout is theirs and is persisted with the lane's open flag.
 *
 * On mobile it is the same drawer as before: a backdrop, a titled header with
 * the close control, and the same blocks underneath.
 *
 * There is intentionally no tab strip and no expanded mode, and the shell
 * keeps no domain data of its own: the Environment block reads git and the
 * runtime through their existing hooks, the WORK block projects the session's
 * todos and run state through theirs, the exports block reads the server's
 * record of what `/export` wrote, and Action required reads the existing
 * attention store and links to the chat's original request cards.
 */
export default function AgentSidebar({
  isMobile,
  projectId,
  projectPath,
  sessionId,
  onClose,
  sessionStore,
  blocks = DEFAULT_AGENT_SIDEBAR_LAYOUT,
  onToggleBlock = () => undefined,
  onMoveBlock = () => undefined,
}: AgentSidebarProps) {
  const { t } = useTranslation();

  const sections: Record<AgentSidebarBlock, ReactNode> = {
    environment: <AgentSidebarEnvironment projectId={projectId} projectPath={projectPath} sessionId={sessionId} />,
    git: <AgentSidebarGit projectId={projectId} />,
    stats: <AgentSidebarStats projectId={projectId} projectPath={projectPath} />,
    work: <AgentSidebarWork sessionId={sessionId} sessionStore={sessionStore} />,
    actionRequired: <AgentSidebarActionRequired sessionId={sessionId} onRequestShown={isMobile ? onClose : undefined} />,
    exports: <AgentSidebarExports projectId={projectId} sessionId={sessionId} />,
  };
  const visible = blocks.filter((entry) => entry.visible);
  const content = visible.map((entry) => (
    <Fragment key={entry.block}>{sections[entry.block]}</Fragment>
  ));
  const layout = (
    <AgentSidebarLayoutPanel blocks={blocks} onToggleBlock={onToggleBlock} onMoveBlock={onMoveBlock} />
  );

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          aria-label={t('agentSidebar.close')}
          onClick={onClose}
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-xs"
        />
        <aside
          aria-label={t('agentSidebar.title')}
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[85vw] flex-col overflow-x-hidden border-l border-border/60 bg-sidebar shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            <h2 className="truncate text-sm font-medium text-foreground">{t('agentSidebar.title')}</h2>
            <button
              type="button"
              aria-label={t('agentSidebar.close')}
              title={t('agentSidebar.close')}
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
          <div className="flex shrink-0 justify-end border-t border-border/60 px-3 py-2">{layout}</div>
        </aside>
      </>
    );
  }

  // A narrower window gets a narrower lane so the conversation keeps its room.
  return (
    <aside
      aria-label={t('agentSidebar.title')}
      className="flex w-64 shrink-0 flex-col overflow-y-auto py-3 pr-4 pl-2 lg:w-80"
    >
      <div className="rounded-xl border border-border/60 bg-card/50">{content}</div>
      {/* `mt-auto` puts the one control at the lane's bottom-right corner, not
          floating under the last block. */}
      <footer className="mt-auto flex justify-end px-1 pt-2">{layout}</footer>
    </aside>
  );
}
