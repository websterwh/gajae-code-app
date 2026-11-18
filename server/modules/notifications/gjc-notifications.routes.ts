import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import {
  applyNotificationPatch,
  notificationView,
  readNotificationsFromYaml,
  telegramCredentials,
  writeNotificationsToYaml,
} from './gjc-notifications.config.js';
import { sendTelegramMessage } from './telegram.service.js';

const router = express.Router();

/** The same agent directory the CLI reads; its config.yml is the source here. */
const agentDir = (): string => process.env.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');

const configFile = (): string => path.join(agentDir(), 'config.yml');

async function readConfig(): Promise<string> {
  try {
    return await readFile(configFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

router.get('/', asyncHandler(async (_request, response) => {
  return response.json({ success: true, data: notificationView(readNotificationsFromYaml(await readConfig())) });
}));

router.put('/', asyncHandler(async (request, response) => {
  const file = configFile();
  const current = await readConfig();
  const next = writeNotificationsToYaml(
    current,
    applyNotificationPatch(readNotificationsFromYaml(current), request.body ?? {}),
  );

  // The CLI reads this file too, so it is replaced atomically: a half-written
  // config.yml would break every run that starts between the two writes.
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, next, { mode: 0o600 });
  await rename(temporary, file);

  return response.json({ success: true, data: notificationView(readNotificationsFromYaml(next)) });
}));

// The test uses the values on the form when it has them, so a token or chat id
// can be checked before it is saved; a blank field means "the stored one", the
// same rule the patch follows.
router.post('/telegram/test', asyncHandler(async (request, response) => {
  const config = readNotificationsFromYaml(await readConfig());
  const stored = telegramCredentials(config);
  const view = notificationView(config);
  const input = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const field = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;

  const botToken = field(input.botToken, stored.botToken);
  const chatId = field(input.chatId, stored.chatId);
  if (!botToken || !chatId) {
    return response.status(400).json({ error: { message: 'A bot token and chat ID are required.' } });
  }

  const result = await sendTelegramMessage({
    botToken,
    chatId,
    text: 'Gajae Code test notification: Telegram delivery is configured.',
  });
  if (!result.ok) return response.status(502).json({ error: { message: result.description } });

  // `enabled` is why a working bot still sends nothing during a run: the test
  // proves the credentials, the caller decides whether to mention the switches.
  return response.json({
    success: true,
    data: { delivered: true, enabled: view.enabled, telegramEnabled: view.telegram.enabled },
  });
}));

export default router;
