import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import {
  applyNotificationPatch,
  notificationView,
  readNotificationsFromYaml,
  writeNotificationsToYaml,
} from './gjc-notifications.config.js';

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

export default router;
