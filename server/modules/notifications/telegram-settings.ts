import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { notificationView, readNotificationsFromYaml, telegramCredentials } from './gjc-notifications.config.js';

export function telegramAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  // Callers may pass a partial env; fall back to the process for the rest.
  return env.GJC_WORKER_AGENT_DIR || process.env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
}

/**
 * The credentials a notification may use, read fresh so a settings save applies
 * to the next event. Both switches must be on and both fields present.
 */
export function readTelegramDelivery(env: NodeJS.ProcessEnv = process.env): { botToken: string; chatId: string } | null {
  try {
    const config = readNotificationsFromYaml(readFileSync(path.join(telegramAgentDir(env), 'config.yml'), 'utf8'));
    const view = notificationView(config);
    if (!view.enabled || !view.telegram.enabled) return null;
    const credentials = telegramCredentials(config);
    return credentials.botToken && credentials.chatId ? credentials : null;
  } catch {
    return null;
  }
}
