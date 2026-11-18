import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Pencil } from 'lucide-react';

import type { AgentSidebarBlock, AgentSidebarLayoutEntry } from '../agentSidebarState';

export type AgentSidebarLayoutPanelProps = {
  blocks: AgentSidebarLayoutEntry[];
  onToggleBlock: (block: AgentSidebarBlock) => void;
  onMoveBlock: (block: AgentSidebarBlock, direction: -1 | 1) => void;
};

const iconButtonClass = 'rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30';

/**
 * The lane's one setting: which blocks it shows, and in what order.
 *
 * A pencil in the lane's bottom-right corner opens a small panel rather than a
 * dialog, because the change is live and the lane has to stay visible while it
 * is made. Reordering is two buttons per row instead of drag and drop: it works
 * with a keyboard, on touch, and without a library.
 */
export default function AgentSidebarLayoutPanel({ blocks, onToggleBlock, onMoveBlock }: AgentSidebarLayoutPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const nameOf = (block: AgentSidebarBlock): string => t(`agentSidebar.${block}.title`);

  return (
    <div ref={container} className="relative">
      {open && (
        <div
          role="group"
          aria-label={t('agentSidebar.layout.title')}
          className="absolute right-0 bottom-full z-20 mb-1 w-60 rounded-lg border border-border bg-popover p-2 text-xs shadow-lg"
        >
          <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
            {t('agentSidebar.layout.title')}
          </p>
          <ul className="space-y-0.5">
            {blocks.map((entry, index) => (
              <li key={entry.block} className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-muted/50">
                <input
                  type="checkbox"
                  checked={entry.visible}
                  onChange={() => onToggleBlock(entry.block)}
                  aria-label={t('agentSidebar.layout.show', { name: nameOf(entry.block) })}
                  className="h-3 w-3 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{nameOf(entry.block)}</span>
                <button
                  type="button"
                  onClick={() => onMoveBlock(entry.block, -1)}
                  disabled={index === 0}
                  aria-label={t('agentSidebar.layout.moveUp', { name: nameOf(entry.block) })}
                  title={t('agentSidebar.layout.moveUp', { name: nameOf(entry.block) })}
                  className={iconButtonClass}
                >
                  <ArrowUp className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => onMoveBlock(entry.block, 1)}
                  disabled={index === blocks.length - 1}
                  aria-label={t('agentSidebar.layout.moveDown', { name: nameOf(entry.block) })}
                  title={t('agentSidebar.layout.moveDown', { name: nameOf(entry.block) })}
                  className={iconButtonClass}
                >
                  <ArrowDown className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t('agentSidebar.layout.title')}
        title={t('agentSidebar.layout.title')}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
