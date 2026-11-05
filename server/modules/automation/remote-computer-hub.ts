import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import {
  REMOTE_CUA_PROTOCOL_VERSION,
  isRemoteCuaMessage,
  type RemoteCuaComputerRequest,
  type RemoteCuaReadiness,
} from '../../../shared/remote-cua-protocol.js';

import { guardCuaCall } from './cua-capability.js';
import { isCuaSafeTool, type CuaSafeTool } from './cua-client.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout };
type Connection = { socket: WebSocket; pending: Map<string, Pending>; seen: Set<string> };

/** Multiplexes authenticated companion connections; no desktop capability lives on the server. */
export class RemoteComputerHub {
  private readonly connections = new Map<string, Connection>();
  constructor(readonly devices: RemoteComputerDeviceRegistry) {}

  handle(socket: WebSocket): void {
    let deviceId: string | undefined;
    const reject = (reason: string) => { socket.close(1008, reason); };
    socket.on('message', raw => {
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { reject('invalid JSON'); return; }
      if (!isRemoteCuaMessage(message)) { reject('unsupported protocol'); return; }
      if (message.type === 'hello') {
        if (deviceId) { reject('invalid hello'); return; }
        try {
          let identity: { id: string }; let credential: string | undefined;
          if (message.pairingToken) {
            const paired = this.devices.consumePairing(message.pairingToken, message.deviceName ?? '', message.os ?? '');
            identity = paired.device; credential = paired.credential;
            socket.send(JSON.stringify({ type: 'paired', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, deviceId: identity.id, credential }));
          } else {
            if (!message.deviceId || !message.credential) throw new Error('invalid hello');
            identity = this.devices.authenticate(message.deviceId, message.credential);
          }
          const old = this.connections.get(identity.id);
          if (old) old.socket.close(4001, 'reconnected');
          deviceId = identity.id;
          this.connections.set(deviceId, { socket, pending: new Map(), seen: new Set() });
          socket.send(JSON.stringify({ type: 'pong', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION }));
        } catch { reject('authentication failed'); }
        return;
      }
      if (!deviceId) { reject('hello required'); return; }
      const connection = this.connections.get(deviceId);
      if (!connection || connection.socket !== socket) { reject('stale connection'); return; }
      if (message.type === 'readiness') {
        this.devices.update(deviceId, { readiness: message.readiness });
      } else if (message.type === 'computer.result') {
        if (message.deviceId !== deviceId || !message.requestId) { reject('device mismatch'); return; }
        const pending = connection.pending.get(message.requestId);
        if (!pending) return; // Late result after cancellation/timeout is harmless.
        connection.pending.delete(message.requestId); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION }));
      }
    });
    socket.once('close', () => {
      if (!deviceId || this.connections.get(deviceId)?.socket !== socket) return;
      const connection = this.connections.get(deviceId)!;
      this.connections.delete(deviceId);
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Remote computer disconnected.')); }
    });
  }

  async call(deviceId: string, appSessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.devices.dispatchable(deviceId);
    const connection = this.connections.get(deviceId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) throw new Error('Remote computer is offline.');
    if (!isCuaSafeTool(tool)) throw new Error('Unreviewed computer tool.');
    const guarded = guardCuaCall(tool, args).arguments;
    const requestId = randomUUID();
    const deadline = Date.now() + 30_000;
    if (connection.seen.has(requestId)) throw new Error('Duplicate remote computer request.');
    connection.seen.add(requestId);
    const request: RemoteCuaComputerRequest = {
      type: 'computer.request', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, requestId, deviceId, appSessionId,
      tool, arguments: guarded, deadline,
    };
    return new Promise<unknown>((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = connection.pending.get(requestId);
        if (!pending) return;
        connection.pending.delete(requestId); clearTimeout(pending.timer);
        try { connection.socket.send(JSON.stringify({ type: 'cancel', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, requestId, deviceId })); } catch { /* disconnected */ }
        reject(error);
      };
      const timer = setTimeout(() => finish(new Error('Remote computer request timed out.')), 30_000);
      connection.pending.set(requestId, { resolve, reject, timer });
      signal?.addEventListener('abort', () => finish(new Error('Remote computer request cancelled.')), { once: true });
      connection.socket.send(JSON.stringify(request));
    });
  }

  disconnect(deviceId: string, reason: 'revoked' | 'disabled' = 'revoked'): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    connection.socket.send(JSON.stringify({ type: 'disconnect', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, reason }));
    connection.socket.close(4003, reason);
  }
  readiness(deviceId: string): RemoteCuaReadiness | undefined {
    return this.devices.list().find(device => device.id === deviceId)?.readiness;
  }
}
