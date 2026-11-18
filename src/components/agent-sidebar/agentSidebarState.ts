/**
 * Persisted state for the right-hand Agent sidebar.
 *
 * The sidebar is the one production right-hand surface, and its state is
 * deliberately small: whether the lane is open, and the reader's own order and
 * visibility for the blocks inside it. A record written by the earlier
 * resizable rail (`{ open, width }`) is read for its `open` alone, and the next
 * write drops the stale field.
 */

/** Every block the lane can show; the default order is this order. */
export const AGENT_SIDEBAR_BLOCKS = ['environment', 'stats', 'work', 'actionRequired', 'exports'] as const;

export type AgentSidebarBlock = (typeof AGENT_SIDEBAR_BLOCKS)[number];

/** Exports default last: the lane's stable facts sit above the files it hands out. */
export const DEFAULT_AGENT_SIDEBAR_LAYOUT: AgentSidebarLayoutEntry[] = AGENT_SIDEBAR_BLOCKS.map((block) => ({
  block,
  visible: true,
}));

export type AgentSidebarLayoutEntry = {
  block: AgentSidebarBlock;
  visible: boolean;
};

export type AgentSidebarState = {
  open: boolean;
  blocks: AgentSidebarLayoutEntry[];
};

export type AgentSidebarStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const AGENT_SIDEBAR_STORAGE_KEY = 'agent-sidebar';

/** The conversation keeps at least this much of the row beside the lane. */
export const MIN_AGENT_SIDEBAR_CHAT_WIDTH = 200;

const defaultLayout = (): AgentSidebarLayoutEntry[] => DEFAULT_AGENT_SIDEBAR_LAYOUT.map((entry) => ({ ...entry }));

export const defaultAgentSidebarState = (): AgentSidebarState => ({
  open: false,
  blocks: defaultLayout(),
});

export const DEFAULT_AGENT_SIDEBAR_STATE: AgentSidebarState = defaultAgentSidebarState();

const isBlock = (value: unknown): value is AgentSidebarBlock => (
  typeof value === 'string' && (AGENT_SIDEBAR_BLOCKS as readonly string[]).includes(value)
);

/**
 * Moves `block` to `toIndex`, clamping to the list and returning the same array
 * when nothing would change, so the caller can skip a write.
 */
export function reorderBlocks(
  layout: AgentSidebarLayoutEntry[],
  block: AgentSidebarBlock,
  toIndex: number,
): AgentSidebarLayoutEntry[] {
  const index = layout.findIndex((entry) => entry.block === block);
  if (index < 0) return layout;
  const target = Math.max(0, Math.min(layout.length - 1, toIndex));
  if (target === index) return layout;
  const next = [...layout];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Unknown blocks and duplicate entries are dropped, and a block the stored
 * record predates is appended in its default position - a new block must not
 * vanish from a reader's lane because they saved a layout before it existed.
 */
function readLayout(value: unknown): AgentSidebarLayoutEntry[] {
  const layout: AgentSidebarLayoutEntry[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { block, visible } = entry as Record<string, unknown>;
      if (!isBlock(block) || layout.some((item) => item.block === block)) continue;
      layout.push({ block, visible: visible !== false });
    }
  }
  for (const block of AGENT_SIDEBAR_BLOCKS) {
    if (!layout.some((entry) => entry.block === block)) layout.push({ block, visible: true });
  }
  return layout;
}

export function readAgentSidebarState(storage: AgentSidebarStorage | null): AgentSidebarState {
  if (!storage) {
    return defaultAgentSidebarState();
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(AGENT_SIDEBAR_STORAGE_KEY);
  } catch {
    return defaultAgentSidebarState();
  }

  if (raw === null) {
    return defaultAgentSidebarState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultAgentSidebarState();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaultAgentSidebarState();
  }

  return {
    open: (parsed as Record<string, unknown>).open === true,
    blocks: readLayout((parsed as Record<string, unknown>).blocks),
  };
}

export function writeAgentSidebarState(storage: AgentSidebarStorage | null, state: AgentSidebarState): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(AGENT_SIDEBAR_STORAGE_KEY, JSON.stringify({
      open: state.open,
      blocks: state.blocks.map(({ block, visible }) => ({ block, visible })),
    }));
  } catch {
    // A full or blocked storage must not take the sidebar down with it.
  }
}
