import { useCallback, useEffect, useState } from 'react';

import {
  readAgentSidebarState,
  reorderBlocks,
  writeAgentSidebarState,
  type AgentSidebarBlock,
  type AgentSidebarState,
} from '../agentSidebarState';

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari throws on localStorage access with cookies blocked.
    return null;
  }
}

/**
 * Owns the Agent sidebar: whether it is open, and the reader's order and
 * visibility for the blocks inside it. Both live in one persisted record under
 * the `agent-sidebar` key.
 */
export function useAgentSidebar() {
  const [state, setState] = useState<AgentSidebarState>(() => readAgentSidebarState(browserStorage()));

  useEffect(() => {
    writeAgentSidebarState(browserStorage(), state);
  }, [state]);

  const open = useCallback(() => {
    setState((previous) => (previous.open ? previous : { ...previous, open: true }));
  }, []);

  const close = useCallback(() => {
    setState((previous) => (previous.open ? { ...previous, open: false } : previous));
  }, []);

  const toggle = useCallback(() => {
    setState((previous) => ({ ...previous, open: !previous.open }));
  }, []);

  const toggleBlock = useCallback((block: AgentSidebarBlock) => {
    setState((previous) => ({
      ...previous,
      blocks: previous.blocks.map((entry) => (
        entry.block === block ? { ...entry, visible: !entry.visible } : entry
      )),
    }));
  }, []);

  /** Drag and the arrow keys both land here: a block and where it should sit. */
  const moveBlock = useCallback((block: AgentSidebarBlock, toIndex: number) => {
    setState((previous) => {
      const blocks = reorderBlocks(previous.blocks, block, toIndex);
      return blocks === previous.blocks ? previous : { ...previous, blocks };
    });
  }, []);

  return {
    isOpen: state.open,
    blocks: state.blocks,
    open,
    close,
    toggle,
    toggleBlock,
    moveBlock,
  };
}
