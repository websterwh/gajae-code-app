import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_SIDEBAR_BLOCKS,
  AGENT_SIDEBAR_STORAGE_KEY,
  DEFAULT_AGENT_SIDEBAR_STATE,
  readAgentSidebarState,
  writeAgentSidebarState,
  type AgentSidebarBlock,
  type AgentSidebarStorage,
} from './agentSidebarState';

function createStorage(seed: Record<string, string> = {}): AgentSidebarStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

const layout = (
  entries: Array<[AgentSidebarBlock, boolean]> = AGENT_SIDEBAR_BLOCKS.map((block): [AgentSidebarBlock, boolean] => [block, true]),
) => entries.map(([block, visible]) => ({ block, visible }));

test('the sidebar starts closed with every block shown, exports last', () => {
  assert.deepEqual(DEFAULT_AGENT_SIDEBAR_STATE, {
    open: false,
    blocks: [
      { block: 'environment', visible: true },
      { block: 'work', visible: true },
      { block: 'actionRequired', visible: true },
      { block: 'exports', visible: true },
    ],
  });
});

test('no storage at all yields the default instead of throwing', () => {
  assert.deepEqual(readAgentSidebarState(null), DEFAULT_AGENT_SIDEBAR_STATE);
});

test('a storage that has never seen the sidebar yields the default', () => {
  assert.deepEqual(readAgentSidebarState(createStorage()), DEFAULT_AGENT_SIDEBAR_STATE);
});

test('a corrupt or foreign payload degrades to the default instead of rendering garbage', () => {
  assert.deepEqual(readAgentSidebarState(createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: 'not json' })), DEFAULT_AGENT_SIDEBAR_STATE);
  assert.deepEqual(readAgentSidebarState(createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: '"a string"' })), DEFAULT_AGENT_SIDEBAR_STATE);
  assert.deepEqual(readAgentSidebarState(createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: '[1,2,3]' })), DEFAULT_AGENT_SIDEBAR_STATE);
  assert.deepEqual(
    readAgentSidebarState(createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: JSON.stringify({ open: 'yes', width: 'wide' }) })),
    DEFAULT_AGENT_SIDEBAR_STATE,
  );
});

test('a record from the resizable rail keeps its open state and gains the default layout', () => {
  assert.deepEqual(
    readAgentSidebarState(createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: JSON.stringify({ open: true, width: 420 }) })),
    { ...DEFAULT_AGENT_SIDEBAR_STATE, open: true },
  );
});

test('a written state reads back unchanged, layout included', () => {
  const storage = createStorage();
  const state = { open: true, blocks: layout([['work', true], ['exports', false], ['environment', true], ['actionRequired', true]]) };

  writeAgentSidebarState(storage, state);

  assert.deepEqual(readAgentSidebarState(storage), state);
});

test('writing persists the open flag and the layout, dropping a stale width', () => {
  const storage = createStorage({ [AGENT_SIDEBAR_STORAGE_KEY]: JSON.stringify({ open: true, width: 640 }) });

  writeAgentSidebarState(storage, { open: true, blocks: layout([['environment', false], ['work', true], ['actionRequired', true], ['exports', true]]) });

  const persisted = JSON.parse(storage.entries.get(AGENT_SIDEBAR_STORAGE_KEY) ?? '{}');
  assert.deepEqual(Object.keys(persisted).sort(), ['blocks', 'open']);
  assert.deepEqual(persisted.blocks[0], { block: 'environment', visible: false });
});

test('a stored layout keeps its order, drops unknown blocks and appends a block it predates', () => {
  const storage = createStorage({
    [AGENT_SIDEBAR_STORAGE_KEY]: JSON.stringify({
      open: true,
      // No exports entry: a layout saved before exports existed.
      blocks: [
        { block: 'work', visible: false },
        { block: 'nonsense', visible: true },
        { block: 'environment', visible: true },
        { block: 'work', visible: true },
        'not an object',
      ],
    }),
  });

  const state = readAgentSidebarState(storage);
  assert.deepEqual(state.blocks, [
    { block: 'work', visible: false },
    { block: 'environment', visible: true },
    // The missing blocks arrive in their default order rather than vanishing.
    { block: 'actionRequired', visible: true },
    { block: 'exports', visible: true },
  ]);
  assert.deepEqual(new Set(state.blocks.map((entry) => entry.block)), new Set(AGENT_SIDEBAR_BLOCKS));
});

test('a block whose visibility is not a boolean is shown rather than hidden by accident', () => {
  const storage = createStorage({
    [AGENT_SIDEBAR_STORAGE_KEY]: JSON.stringify({ open: true, blocks: [{ block: 'environment', visible: 'no' }] }),
  });

  assert.equal(readAgentSidebarState(storage).blocks[0]?.visible, true);
});

test('the legacy workspace panel state is deliberately not migrated', () => {
  const storage = createStorage({
    'workspace-panel': JSON.stringify({ open: true, tab: 'browser', width: 900 }),
  });

  assert.deepEqual(readAgentSidebarState(storage), DEFAULT_AGENT_SIDEBAR_STATE);
});

test('a storage that throws never propagates out of read or write', () => {
  const hostile: AgentSidebarStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  assert.deepEqual(readAgentSidebarState(hostile), DEFAULT_AGENT_SIDEBAR_STATE);
  assert.doesNotThrow(() => writeAgentSidebarState(hostile, DEFAULT_AGENT_SIDEBAR_STATE));
});
