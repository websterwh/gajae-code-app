import { create } from 'zustand';

import { safeLocalStorage } from '../components/chat/utils/chatStorage';

/**
 * The disposable chat started from "Quick chat".
 *
 * One at a time: starting another quick chat (or an ordinary new conversation)
 * ends this one, and its session is deleted rather than archived. The id is
 * only known once the first turn creates the session, so `attachSession` fills
 * it in afterwards and the previous conversation's id is remembered so it is
 * never mistaken for the new one.
 */
export const QUICK_CHAT_STORAGE_KEY = 'quick-chat-v1';

export type QuickChat = {
  projectId: string;
  /** The conversation this quick chat became, once its first turn created one. */
  sessionId: string | null;
  /** The disposable project that owns the session once it has one. */
  sessionProjectId: string | null;
  /** The conversation open when it started; its id must never be adopted. */
  previousSessionId: string | null;
};

type QuickChatState = {
  quickChat: QuickChat | null;
  start: (projectId: string, previousSessionId?: string | null) => void;
  attachSession: (projectId: string, sessionId: string, sessionProjectId?: string | null) => void;
  clear: () => void;
};

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

function readPersisted(): QuickChat | null {
  const raw = safeLocalStorage.getItem(QUICK_CHAT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<QuickChat>;
    const projectId = text(parsed.projectId);
    if (!projectId) return null;
    return {
      projectId,
      sessionId: text(parsed.sessionId),
      sessionProjectId: text(parsed.sessionProjectId),
      previousSessionId: text(parsed.previousSessionId),
    };
  } catch {
    return null;
  }
}

function persist(value: QuickChat | null): QuickChat | null {
  if (value) safeLocalStorage.setItem(QUICK_CHAT_STORAGE_KEY, JSON.stringify(value));
  else safeLocalStorage.removeItem(QUICK_CHAT_STORAGE_KEY);
  return value;
}

export const useQuickChatStore = create<QuickChatState>()((set) => ({
  quickChat: readPersisted(),

  start: (projectId, previousSessionId = null) => set({
    quickChat: persist({ projectId, sessionId: null, sessionProjectId: null, previousSessionId: previousSessionId ?? null }),
  }),

  attachSession: (projectId, sessionId, sessionProjectId = null) => set((state) => {
    const current = state.quickChat;
    if (!current || current.sessionId || current.projectId !== projectId) return state;
    if (!sessionId || sessionId === current.previousSessionId) return state;
    return { quickChat: persist({ ...current, sessionId, sessionProjectId }) };
  }),

  clear: () => set({ quickChat: persist(null) }),
}));
