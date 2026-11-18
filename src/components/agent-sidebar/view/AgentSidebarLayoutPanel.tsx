import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, Pencil } from 'lucide-react';

import type { AgentSidebarBlock, AgentSidebarLayoutEntry } from '../agentSidebarState';

export type AgentSidebarLayoutPanelProps = {
  blocks: AgentSidebarLayoutEntry[];
  onToggleBlock: (block: AgentSidebarBlock) => void;
  /** Moves a block to an absolute index, which is where a drop landed. */
  onMoveBlock: (block: AgentSidebarBlock, toIndex: number) => void;
};

/**
 * The lane's one setting: which blocks it shows, and in what order.
 *
 * A pencil in the lane's bottom-right corner opens a small panel rather than a
 * dialog, because the change is live and the lane has to stay visible while it
 * is made. Rows are dragged to reorder. A focused row also moves with the arrow
 * keys, so the gesture keeps a keyboard equivalent without putting two buttons
 * on every line.
 */
export default function AgentSidebarLayoutPanel({ blocks, onToggleBlock, onMoveBlock }: AgentSidebarLayoutPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<AgentSidebarBlock | null>(null);
  const [dropTarget, setDropTarget] = useState<AgentSidebarBlock | null>(null);
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
            {blocks.map((entry, index) => {
              const name = nameOf(entry.block);
              const isTarget = dragging !== null && dragging !== entry.block && dropTarget === entry.block;
              return (
                <li
                  key={entry.block}
                  draggable
                  tabIndex={0}
                  aria-label={t('agentSidebar.layout.reorder', { name })}
                  onDragStart={(event) => {
                    setDragging(entry.block);
                    event.dataTransfer?.setData('text/plain', entry.block);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    if (!dragging) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    setDropTarget(entry.block);
                  }}
                  onDragLeave={() => setDropTarget((current) => (current === entry.block ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging && dragging !== entry.block) onMoveBlock(dragging, index);
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onKeyDown={(event) => {
                    // The checkbox keeps its own arrow keys; only the row moves.
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    onMoveBlock(entry.block, index + (event.key === 'ArrowUp' ? -1 : 1));
                  }}
                  className={`flex items-center gap-1.5 rounded border-t-2 px-1 py-1 hover:bg-muted/50 ${
                    isTarget ? 'border-primary' : 'border-transparent'
                  } ${dragging === entry.block ? 'opacity-40' : ''}`}
                >
                  <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-muted-foreground/70" aria-hidden />
                  <input
                    type="checkbox"
                    checked={entry.visible}
                    onChange={() => onToggleBlock(entry.block)}
                    aria-label={t('agentSidebar.layout.show', { name })}
                    className="h-3 w-3 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                </li>
              );
            })}
          </ul>
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/80">{t('agentSidebar.layout.drag')}</p>
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
