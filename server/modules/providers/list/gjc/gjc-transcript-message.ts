import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * The runtime wraps the generated handoff document in a tag plus a sentence
 * addressed to the next session (`createHandoffContext` in the coding agent).
 * Only the document itself is the agent's work, so the wrapper is removed
 * before anything renders it or derives a title from it.
 */
const HANDOFF_CONTEXT = /^<handoff-context>\r?\n([\s\S]*?)\r?\n<\/handoff-context>/u;

function readHandoffDocument(content: unknown): string | null {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        const record = readObjectRecord(part);
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .join('');
  }

  const trimmed = text.trim();
  if (!trimmed) return null;
  const document = (HANDOFF_CONTEXT.exec(trimmed)?.[1] ?? trimmed).trim();
  return document || null;
}

/**
 * Reads a normal SDK message, the visible user request behind a skill entry, or
 * the handoff document that is the entire content of a continued session.
 *
 * Skill content is expanded instructions, not the user's prompt. Only the
 * explicit attribution and structured name/args can reconstruct that prompt;
 * never fall back to parsing content, paths, or other custom message types.
 * A handoff is the opposite case: the document *is* what the session starts
 * with, so it is read as the first visible message - without it a continued
 * session has no history and no title. History, turn lineage, and session
 * titles must use the same interpretation.
 */
export function readGjcTranscriptMessage(value: unknown): AnyRecord | null {
  const entry = readObjectRecord(value);
  if (!entry) return null;
  if (entry.type === 'message') return readObjectRecord(entry.message);
  if (entry.type !== 'custom_message') return null;

  // Mirrors the runtime's own visibility rule for handoffs: displayed only,
  // regardless of attribution, because the document carries no user prompt.
  if (entry.customType === 'handoff') {
    if (entry.display !== true) return null;
    const document = readHandoffDocument(entry.content);
    return document ? { role: 'user', content: document } : null;
  }

  // `/btw-handoff` is a displayed user message whose model-facing body is a
  // framed transcript of the side chat. Showing that body would dump the whole
  // discussion into the main chat, so history keeps only the same one-line
  // marker the CLI renders; the full message remains in the transcript and is
  // still what the model receives.
  if (entry.customType === 'btw-handoff') {
    if (entry.display !== true || entry.attribution !== 'user') return null;
    const details = readObjectRecord(entry.details);
    const count = typeof details?.exchangeCount === 'number'
      && Number.isSafeInteger(details.exchangeCount)
      && details.exchangeCount > 0
      ? details.exchangeCount
      : null;
    return {
      role: 'user',
      content: count === null
        ? 'Side chat handed off to chat.'
        : `Side chat handed off to chat (${count} ${count === 1 ? 'exchange' : 'exchanges'}).`,
    };
  }

  if (
    entry.customType !== 'skill-prompt'
    || entry.display !== true
    || entry.attribution !== 'user'
  ) return null;

  const details = readObjectRecord(entry.details);
  if (
    !details
    || typeof details.name !== 'string'
    || !/^[\p{L}\p{N}_.:-]+$/u.test(details.name)
    || (details.args !== undefined && typeof details.args !== 'string')
  ) return null;

  return {
    role: 'user',
    content: `/skill:${details.name}${details.args ? ` ${details.args}` : ''}`,
  };
}

/**
 * The public delegation snapshot carried by a projected receipt row: identity
 * and state only. The durable receipt keeps `resultText`, `file`, `owner`,
 * `root` and `childSessionId`, and none of them may reach the browser.
 */
export type GjcDelegationReceiptUpdate = {
  delegationId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  agent: string;
  description: string;
  executionMode?: 'default' | 'ultragoal-red-team';
  repositoryBinding?: AnyRecord;
};

const DELEGATION_RECEIPT_TYPE = 'gajae-app.delegation.v1';
const DELEGATION_STATUSES = new Set<GjcDelegationReceiptUpdate['status']>(['running', 'completed', 'failed', 'cancelled']);
const DELEGATION_EXECUTION_MODES = new Set<NonNullable<GjcDelegationReceiptUpdate['executionMode']>>(['default', 'ultragoal-red-team']);

/**
 * Reads an App delegation receipt (`gajae-app.delegation.v1`) written into the
 * owner's transcript by `GjcDelegationExecutor`.
 *
 * Deliberately narrow on both ends: only this one custom type is read - every
 * other custom entry an extension or the runtime may append stays invisible -
 * and only the public snapshot fields leave the function, so a widened receipt
 * can never leak child identifiers or result text into history.
 */
export function readGjcDelegationReceipt(value: unknown): GjcDelegationReceiptUpdate | null {
  const entry = readObjectRecord(value);
  if (!entry || entry.type !== 'custom' || entry.customType !== DELEGATION_RECEIPT_TYPE) return null;

  const data = readObjectRecord(entry.data);
  if (!data) return null;

  const { id, status, agent, description, executionMode } = data;
  if (
    typeof id !== 'string' || !id
    || typeof status !== 'string' || !DELEGATION_STATUSES.has(status as GjcDelegationReceiptUpdate['status'])
    || typeof agent !== 'string' || !agent
    || typeof description !== 'string'
  ) return null;
  if (
    executionMode !== undefined
    && (typeof executionMode !== 'string' || !DELEGATION_EXECUTION_MODES.has(executionMode as NonNullable<GjcDelegationReceiptUpdate['executionMode']>))
  ) return null;

  const repositoryBinding = readObjectRecord(data.repositoryBinding);
  return {
    delegationId: id,
    status: status as GjcDelegationReceiptUpdate['status'],
    agent,
    description,
    ...(executionMode === undefined ? {} : { executionMode: executionMode as NonNullable<GjcDelegationReceiptUpdate['executionMode']> }),
    ...(repositoryBinding ? { repositoryBinding } : {}),
  };
}
