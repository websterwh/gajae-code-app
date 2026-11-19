/**
 * Who owns the Telegram bot for app sessions.
 *
 * The CLI's design has exactly one reader: its notification daemon. SDK
 * sessions that opt in are attached to that daemon, which creates the topic,
 * renders the turn and injects replies. The app can either keep its own
 * sender/poller or yield the bot to the daemon.
 *
 * Daemon ownership is opt-in (`GJC_TELEGRAM_OWNER=daemon`) and only takes
 * effect when Telegram is actually configured. With no configuration the app
 * keeps its current path, so an unconfigured or half-configured install never
 * goes silent.
 */

import { readTelegramDelivery } from './telegram-settings.js';

export type TelegramOwner = 'app' | 'daemon';

export function resolveTelegramOwner(env: NodeJS.ProcessEnv = process.env): TelegramOwner {
  return env.GJC_TELEGRAM_OWNER?.trim().toLowerCase() === 'daemon' ? 'daemon' : 'app';
}

/** True when the CLI daemon should own delivery: asked for, and configured. */
export function daemonOwnsTelegram(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveTelegramOwner(env) === 'daemon' && readTelegramDelivery(env) !== null;
}

/**
 * The notification-admission switch for app-spawned SDK workers.
 *
 * `GJC_NOTIFICATIONS=0` is a hard opt-out in the SDK: it makes the session
 * ineligible for the daemon, so the app must not set it while the daemon owns
 * the bot. In app mode it stays `0`, which is what keeps the daemon from
 * sending duplicates beside the app.
 */
export function workerNotificationsEnv(env: NodeJS.ProcessEnv = process.env): '0' | '1' {
  if (env.GJC_NOTIFICATIONS === '0' || env.GJC_NOTIFICATIONS === '1') return env.GJC_NOTIFICATIONS;
  return daemonOwnsTelegram(env) ? '1' : '0';
}
