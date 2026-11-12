import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import { automationService } from '@/modules/automation/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { isPrivateAddress } from '@/shared/peer-address.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type UpgradeVerifier = Parameters<typeof verifyWebSocketClient>[1];
type GatewayDependencies = {
  verifyClient: UpgradeVerifier;
  chat: Parameters<typeof handleChatConnection>[2]; shell: Parameters<typeof handleShellConnection>[1];
};

function startHeartbeat(socket: Parameters<typeof handleChatConnection>[0]): void {
  const heartbeat = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    // Closing a socket can race with the periodic probe.
    try { socket.ping(); } catch { /* raced with close */ }
  }, 30_000);

  const stopHeartbeat = () => clearInterval(heartbeat);
  socket.on('close', stopHeartbeat);
  socket.on('error', stopHeartbeat);
}

/**
 * The pathname of an upgrade target, or `null` when the target is not a URL.
 * `new URL` throws on targets such as `//[`, and a throw inside `verifyClient`
 * leaves the handshake unanswered instead of aborting it: the client would wait
 * forever for a response that a malformed target must never earn. Callers treat
 * `null` as a target that is not one of their routes.
 */
function upgradePath(raw: string | undefined): string | null {
  try {
    return new URL(raw ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function connectionPath(request: AuthenticatedWebSocketRequest): string {
  return upgradePath(request.url) ?? '';
}

/**
 * Whether a `/remote-cua` upgrade arrived over an actually-encrypted
 * transport, either directly or through a reverse proxy that terminates TLS.
 *
 * `x-forwarded-proto` is attacker-controllable on any request that reaches
 * this process directly (this is a raw Node upgrade handler, not an Express
 * `req`; `trust proxy` does not gate it), so it counts only when the peer that
 * sent it is loopback or on a private network - which is what a proxy on this
 * host or its container network is, and what an internet client is not. That is
 * the same rule the sign-in gate uses to decide who a request is, so there is
 * no separate switch to set, and no opt-in that stays forgotten on a
 * deployment that needs it.
 */
export function isEncryptedRemoteCuaUpgrade(
  info: {
    req: {
      headers: Record<string, string | string[] | undefined>;
      socket: { encrypted?: boolean; remoteAddress?: string };
    };
  },
  env: { nodeEnv?: string } = { nodeEnv: process.env.NODE_ENV },
): boolean {
  const host = String(info.req.headers.host ?? '').split(':', 1)[0];
  const localhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const forwardedHttps = isPrivateAddress(String(info.req.socket.remoteAddress ?? ''))
    && String(info.req.headers['x-forwarded-proto'] ?? '').split(',', 1)[0].trim() === 'https';
  return Boolean(info.req.socket.encrypted) || forwardedHttps || (localhost && env.nodeEnv !== 'production');
}

export function createWebSocketServer(server: HttpServer, dependencies: GatewayDependencies): WebSocketServer {
  const verification = {
    // The companion has no API key. It authenticates its device credential in
    // the first protocol frame; this exception is deliberately path-scoped.
    verifyClient: (info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]) => {
      const path = upgradePath(info.req.url);
      if (path !== '/remote-cua') return verifyWebSocketClient(info, dependencies.verifyClient);
      return isEncryptedRemoteCuaUpgrade(info as never);
    },
  };
  const gateway = new WebSocketServer({ ...verification, server });

  gateway.on('connection', (socket, rawRequest) => {
    startHeartbeat(socket);
    const request = rawRequest as AuthenticatedWebSocketRequest;
    const pathname = connectionPath(request);
    const routeHandlers: Record<string, () => boolean> = {
      '/shell': () => {
        handleShellConnection(socket, dependencies.shell);
        return true;
      },
      '/ws': () => {
        handleChatConnection(socket, request, dependencies.chat);
        return true;
      },
      '/desktop-notifications': () => {
        handleDesktopNotificationsConnection(socket, request);
        return true;
      },
      '/remote-cua': () => {
        automationService.remoteComputerHub.handle(socket);
        return true;
      },
    };
    if (routeHandlers[pathname]?.()) return;

    console.log('[WARN] Unknown WebSocket path:', pathname);
    socket.close();
  });
  return gateway;
}
