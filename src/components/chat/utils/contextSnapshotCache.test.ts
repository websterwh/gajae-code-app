import assert from 'node:assert/strict';
import test from 'node:test';

import { cacheContextFacts, readCachedContextFacts } from './contextSnapshotCache';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
  configurable: true,
});

test('reported context facts round-trip per session', () => {
  cacheContextFacts('session-a', {
    contextTokens: 53_760,
    contextWindow: 128_000,
    contextPercent: 42,
    modelId: 'openai/gpt-test',
    contextSource: 'exact',
  });

  assert.deepEqual(readCachedContextFacts('session-a'), {
    modelId: 'openai/gpt-test',
    contextTokens: 53_760,
    contextWindow: 128_000,
    contextPercent: 42,
    contextSource: 'exact',
  });
  assert.equal(readCachedContextFacts('session-b'), null, 'another session never inherits these numbers');
});

test('a later report merges with the facts already cached', () => {
  cacheContextFacts('session-merge', { contextWindow: 200_000, contextPercent: 10 });
  cacheContextFacts('session-merge', { contextPercent: 22 });

  const facts = readCachedContextFacts('session-merge');
  assert.equal(facts?.contextPercent, 22, 'the newer percentage wins');
  assert.equal(facts?.contextWindow, 200_000, 'the window it was reported against is kept');
});

test('only context facts are cached, never goal or activity state', () => {
  cacheContextFacts('session-facts', {
    contextPercent: 7,
    contextWindow: 1_000,
    goal: { objective: 'not a context fact' },
    activity: { running: true },
  });

  assert.deepEqual(readCachedContextFacts('session-facts'), { contextWindow: 1_000, contextPercent: 7 });
});

test('a state with no context facts caches nothing', () => {
  cacheContextFacts('session-empty', { goal: null });
  assert.equal(readCachedContextFacts('session-empty'), null);
  cacheContextFacts('session-empty', null);
  assert.equal(readCachedContextFacts('session-empty'), null);
});

test('the cache is bounded, evicting the oldest sessions first', () => {
  for (let index = 0; index < 205; index += 1) {
    cacheContextFacts(`session-${index}`, { contextPercent: index, contextWindow: 1_000 });
  }

  assert.equal(readCachedContextFacts('session-0'), null, 'the oldest entry was evicted');
  assert.equal(readCachedContextFacts('session-4'), null);
  assert.equal(readCachedContextFacts('session-5')?.contextPercent, 5, 'the newest 200 survive');
  assert.equal(readCachedContextFacts('session-204')?.contextPercent, 204);
});
