import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { WebSocket } from 'ws';

import {
  REMOTE_CUA_PROTOCOL_VERSION,
  isRemoteCuaMessage,
  type RemoteCuaComputerRequest,
  type RemoteCuaReadiness,
} from '../../../shared/remote-cua-protocol.js';

import { guardAgentDesktopCall } from './agent-desktop-capability.js';
import { isAgentDesktopSafeTool } from './agent-desktop-client.js';
import { guardLocalMachineCall, isLocalMachineTool, type ComputerTool } from './local-machine-capability.js';
import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout };
type Connection = { socket: WebSocket; pending: Map<string, Pending>; seen: Set<string> };

/** Multiplexes authenticated companion connections; no desktop capability lives on the server. */
export class RemoteComputerHub {
  private readonly connections = new Map<string, Connection>();
  /**
   * Fires 'changed' whenever anything the Settings page's device list
   * renders could have moved: a device connects/disconnects, registers,
   * gets approved, or reports readiness. Backs the SSE subscription in
   * automation.routes.ts so the client never has to poll - a plain
   * EventEmitter is enough since this process is the only writer and the
   * route just re-reads devices.list()/isConnected() on each event rather
   * than needing the event payload itself.
   */
  readonly events = new EventEmitter();
  constructor(readonly devices: RemoteComputerDeviceRegistry) {}
  private notifyChanged(): void { this.events.emit('changed'); }

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
          let identity: { id: string }; let credential: string | undefined; let pendingApproval = false;
          // A stored credential, when present, is tried first even if a
          // --pair token was also sent: a healthy existing credential should
          // just reconnect, not waste a freshly-issued token. The token (if
          // any) only gets consumed as a fallback, when the stored
          // credential turns out to be dead (removed/revoked) - this is
          // exactly the case that silently dropped a user-supplied --pair
          // token before: the companion only ever sent the token on a
          // *first-ever* hello, so a dead stored credential made it stop
          // sending the token at all, and the fresh token the user had just
          // typed in went completely unused.
          let authenticated: { id: string } | undefined;
          if (message.deviceId && message.credential) {
            try {
              authenticated = this.devices.authenticate(message.deviceId, message.credential);
            } catch (error) {
              if (error instanceof Error && error.message === 'not-yet-approved') {
                // A real, still-registered credential that just can't
                // dispatch calls yet - keep the connection alive, not a
                // dead-end rejection that tells the user to re-pair.
                authenticated = { id: message.deviceId }; pendingApproval = true;
              } else if (!(error instanceof Error && error.message === 'device-not-registered')) {
                throw error;
              }
              // device-not-registered falls through to the pairingToken /
              // registerUnattended branches below instead of rejecting.
            }
          }
          if (authenticated) {
            identity = authenticated;
          } else if (message.pairingToken) {
            // A manually-issued token already is the approval step (it had
            // to be copied out of this server's own Settings page), so this
            // device starts enabled and is never pendingApproval - unlike
            // the no-token branch below, which never proved that.
            const paired = this.devices.consumePairing(message.pairingToken, message.deviceName ?? '', message.os ?? '');
            identity = paired.device; credential = paired.credential;
            socket.send(JSON.stringify({ type: 'paired', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, deviceId: identity.id, credential }));
          } else {
            // No pairing token and no usable stored credential: either the
            // companion's very first run with only --server, or a run whose
            // stored credential was wiped after a prior removal/revoke.
            // Registers a brand-new disabled device instead of requiring a
            // token copied from Settings first - approval still gates it
            // exactly like a token pairing does, this only skips the
            // token-copying step, not the trust gate.
            const registered = this.devices.registerUnattended(message.deviceName ?? '', message.os ?? '');
            identity = registered.device; credential = registered.credential; pendingApproval = true;
            socket.send(JSON.stringify({ type: 'paired', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, deviceId: identity.id, credential }));
          }
          const old = this.connections.get(identity.id);
          if (old) old.socket.close(4001, 'reconnected');
          deviceId = identity.id;
          this.connections.set(deviceId, { socket, pending: new Map(), seen: new Set() });
          socket.send(JSON.stringify({
            type: 'pong', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION,
            ...(pendingApproval ? { pendingApproval: true } : {}),
          }));
          this.notifyChanged();
        } catch (error) { reject(error instanceof Error ? error.message : 'authentication failed'); }
        return;
      }
      if (!deviceId) { reject('hello required'); return; }
      const connection = this.connections.get(deviceId);
      if (!connection || connection.socket !== socket) { reject('stale connection'); return; }
      if (message.type === 'readiness') {
        this.devices.update(deviceId, { readiness: message.readiness });
        this.notifyChanged();
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
      this.notifyChanged();
    });
  }

  async call(deviceId: string, appSessionId: string, tool: ComputerTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.devices.dispatchable(deviceId);
    const connection = this.connections.get(deviceId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) throw new Error('Remote computer is offline.');
    if (!isAgentDesktopSafeTool(tool) && !isLocalMachineTool(tool)) throw new Error('Unreviewed computer tool.');
    // Desktop tools and the opt-in local machine tools have separate policies;
    // the companion enforces the --shell boundary again on its side.
    const guarded = isLocalMachineTool(tool) ? guardLocalMachineCall(tool, args) : guardAgentDesktopCall(tool, args);
    const requestId = randomUUID();
    const deadline = Date.now() + 30_000;
    if (connection.seen.has(requestId)) throw new Error('Duplicate remote computer request.');
    connection.seen.add(requestId);
    const request: RemoteCuaComputerRequest = {
      type: 'computer.request', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION, requestId, deviceId, appSessionId,
      // `guardAgentDesktopCall`/`guardLocalMachineCall` return the canonical
      // `{ tool, arguments }` envelope, not the argument record itself. Sending
      // the envelope as `arguments` made every remote tool call arrive as
      // `{ tool, arguments }`, which agent-desktop rejects with "Unknown
      // argument 'arguments'" - a failure that only showed up over a real
      // companion, never against the in-process transport.
      tool, arguments: guarded.arguments, deadline,
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
    this.notifyChanged();
  }
  /** Lets routes outside this class (PATCH/DELETE/pairings) report a device-list mutation without duplicating this emitter. */
  notifyDevicesChanged(): void { this.notifyChanged(); }
  /**
   * Pushes a live notification to an already-connected device the instant
   * it is Trusted - a no-op if the device is not currently connected, since
   * its next hello will see the already-enabled record and skip the
   * pending state entirely with no notification needed.
   */
  notifyApproved(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(JSON.stringify({ type: 'approved', protocolVersion: REMOTE_CUA_PROTOCOL_VERSION }));
  }
  readiness(deviceId: string): RemoteCuaReadiness | undefined {
    return this.devices.list().find(device => device.id === deviceId)?.readiness;
  }
  /** True only while this device has a live, authenticated socket. */
  isConnected(deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    return Boolean(connection) && connection!.socket.readyState === connection!.socket.OPEN;
  }
}
