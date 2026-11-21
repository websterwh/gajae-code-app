import { safeLocalStorage } from './chatStorage';

/**
 * The context facts the runtime last reported for a session.
 *
 * `session_state` only arrives with a run, and the chat drops it when the
 * session changes, so opening a conversation that was already used left the
 * Agent sidebar without its Context row until the next message. These are the
 * figures the runtime itself reported - window, tokens, percentage, model -
 * kept per session so the lane can show them again the moment the conversation
 * opens.
 *
 * Nothing is derived here. A session that never reported a window is cached
 * without one, and a cached percentage stays the runtime's own number instead
 * of being recomputed against a guessed window. Only the context facts are
 * kept: goal state and activity belong to the live run, not to a stored copy.
 */
const CACHE_PREFIX = 'session_context:';
const INDEX_KEY = 'session_context_index';
/** Enough for a long history without letting the cache grow without bound. */
const MAX_CACHED_SESSIONS = 200;

const FACT_KEYS = [
  'modelId',
  'thinkingLevel',
  'serviceTier',
  'cwd',
  'contextTokens',
  'contextWindow',
  'contextPercent',
  'contextSource',
] as const;

type ContextFactKey = typeof FACT_KEYS[number];
export type CachedContextFacts = Partial<Record<ContextFactKey, string | number>>;

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function readIndex(): string[] {
  const raw = safeLocalStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

function factsOf(state: Record<string, unknown>): CachedContextFacts {
  const facts: CachedContextFacts = {};
  for (const key of FACT_KEYS) {
    const value = state[key];
    if (typeof value === 'string' && value.trim()) facts[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) facts[key] = value;
  }
  return facts;
}

/** Merges the reported facts into what is cached for this session. */
export function cacheContextFacts(sessionId: string, state: Record<string, unknown> | null | undefined): void {
  if (!sessionId || !state || !storageAvailable()) return;
  const facts = factsOf(state);
  if (Object.keys(facts).length === 0) return;

  safeLocalStorage.setItem(`${CACHE_PREFIX}${sessionId}`, JSON.stringify({ ...readCachedContextFacts(sessionId), ...facts }));

  const index = readIndex().filter((id) => id !== sessionId);
  index.push(sessionId);
  const stale = index.splice(0, Math.max(0, index.length - MAX_CACHED_SESSIONS));
  for (const id of stale) safeLocalStorage.removeItem(`${CACHE_PREFIX}${id}`);
  safeLocalStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function readCachedContextFacts(sessionId: string): Record<string, unknown> | null {
  if (!sessionId || !storageAvailable()) return null;
  const raw = safeLocalStorage.getItem(`${CACHE_PREFIX}${sessionId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const facts = factsOf(parsed as Record<string, unknown>);
    return Object.keys(facts).length > 0 ? facts : null;
  } catch {
    return null;
  }
}
