import { homedir } from 'node:os';
import path from 'node:path';

import { Settings } from '@gajae-code/coding-agent/config/settings';
import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

const router = express.Router();

const SOUNDS = new Set(['all', 'important', 'none']);
const VERBOSITIES = new Set(['lean', 'verbose']);
const SCOPES = new Set(['all', 'primary']);

const requiredText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** The same agent directory the CLI reads; its config.yml is the source here. */
const agentDir = (): string => process.env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');

/**
 * The app and the CLI share config.yml, so these settings are edited through
 * the SDK's own settings writer: schema validation, locking and atomic YAML
 * replacement stay the CLI's, and every unrelated key in the file survives.
 */
async function loadedSettings(): Promise<Settings> {
  try {
    return Settings.instance;
  } catch {
    return Settings.init({ agentDir: agentDir() });
  }
}

function telegramOf(settings: Settings) {
  const { telegram } = settings.getNotificationSettingsSnapshot();
  return {
    // The token never leaves the server; the UI only learns whether one is set.
    enabled: telegram.enabled === true,
    hasBotToken: requiredText(telegram.botToken).length > 0,
    chatId: requiredText(telegram.chatId),
    sound: telegram.sound,
    rich: telegram.rich.enabled,
    richDraft: telegram.richDraft.enabled,
    streaming: telegram.streaming.enabled,
    toolActivity: telegram.toolActivity.enabled,
  };
}

function view(settings: Settings) {
  const snapshot = settings.getNotificationSettingsSnapshot();
  return {
    enabled: snapshot.enabled,
    telegram: telegramOf(settings),
    redact: snapshot.redact,
    verbosity: snapshot.verbosity,
    sessionScope: snapshot.sessionScope,
  };
}

function applySettings(settings: Settings, input: Record<string, unknown>): void {
  const set = (settingPath: string, value: unknown) => {
    (settings.set as unknown as (target: string, next: unknown) => void)(settingPath, value);
  };

  if (typeof input.enabled === 'boolean') set('notifications.enabled', input.enabled);
  if (typeof input.redact === 'boolean') set('notifications.redact', input.redact);
  if (typeof input.verbosity === 'string' && VERBOSITIES.has(input.verbosity)) {
    set('notifications.verbosity', input.verbosity);
  }
  if (typeof input.sessionScope === 'string' && SCOPES.has(input.sessionScope)) {
    set('notifications.sessionScope', input.sessionScope);
  }

  const telegram = input.telegram;
  if (!telegram || typeof telegram !== 'object') return;
  const channel = telegram as Record<string, unknown>;
  if (typeof channel.enabled === 'boolean') set('notifications.telegram.enabled', channel.enabled);
  if (typeof channel.chatId === 'string') set('notifications.telegram.chatId', channel.chatId.trim());
  // An empty token means "keep the stored one", so a saved secret is never
  // overwritten by the masked field the browser rendered as blank.
  const token = requiredText(channel.botToken);
  if (token) set('notifications.telegram.botToken', token);
  if (typeof channel.sound === 'string' && SOUNDS.has(channel.sound)) {
    set('notifications.telegram.sound', channel.sound);
  }
  for (const key of ['rich', 'richDraft', 'streaming', 'toolActivity'] as const) {
    if (typeof channel[key] === 'boolean') set(`notifications.telegram.${key}.enabled`, channel[key]);
  }
}

router.get('/', asyncHandler(async (_request, response) => {
  const settings = await Settings.loadReadonly({ agentDir: agentDir() });
  return response.json({ success: true, data: view(settings) });
}));

router.put('/', asyncHandler(async (request, response) => {
  const input = (request.body ?? {}) as Record<string, unknown>;
  const settings = await loadedSettings();
  applySettings(settings, input);
  await settings.flushOrThrow();
  return response.json({ success: true, data: view(settings) });
}));

export default router;
