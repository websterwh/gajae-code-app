import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import { automationService } from '@/modules/automation/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
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

function connectionPath(request: AuthenticatedWebSocketRequest): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

export function createWebSocketServer(server: HttpServer, dependencies: GatewayDependencies): WebSocketServer {
  const verification = {
    // The companion has no API key. It authenticates its device credential in
    // the first protocol frame; this exception is deliberately path-scoped.
    verifyClient: (info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]) => {
      const path = new URL(info.req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/remote-cua') return verifyWebSocketClient(info, dependencies.verifyClient);
      const host = String(info.req.headers.host ?? '').split(':', 1)[0];
      const localhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      return Boolean((info.req.socket as { encrypted?: boolean }).encrypted) || (localhost && process.env.NODE_ENV !== 'production');
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
