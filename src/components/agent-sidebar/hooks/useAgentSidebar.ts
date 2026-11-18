import { useCallback, useEffect, useState } from 'react';

import {
  readAgentSidebarState,
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

  const moveBlock = useCallback((block: AgentSidebarBlock, direction: -1 | 1) => {
    setState((previous) => {
      const index = previous.blocks.findIndex((entry) => entry.block === block);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= previous.blocks.length) return previous;
      const blocks = [...previous.blocks];
      const moved = blocks[index];
      blocks[index] = blocks[target];
      blocks[target] = moved;
      return { ...previous, blocks };
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
