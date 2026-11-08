/**
 * Wire contract between Gajae and the outbound-only CUA companion.
 *
 * This protocol deliberately transports only already-reviewed `computer`
 * calls. It is not a general MCP tunnel.
 */
export const REMOTE_CUA_PROTOCOL_VERSION = 1;

export type RemoteCuaReadiness = {
  driverVersion?: string;
  schemaSupported: boolean;
  daemon: 'running' | 'stopped' | 'unknown';
  accessibility?: boolean;
  screenRecording?: boolean;
  safeTools: readonly string[];
  deviceName: string;
  os: string;
};

export type RemoteCuaComputerRequest = {
  type: 'computer.request';
  protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION;
  requestId: string;
  deviceId: string;
  appSessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  deadline: number;
};

export type RemoteCuaMessage =
  | { type: 'hello'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; deviceId?: string; credential?: string; pairingToken?: string; deviceName?: string; os?: string }
  | { type: 'readiness'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; readiness: RemoteCuaReadiness }
  | RemoteCuaComputerRequest
  | { type: 'computer.result'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; requestId: string; deviceId: string; result?: unknown; error?: string }
  | { type: 'cancel'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; requestId: string; deviceId: string }
  | { type: 'ping'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION }
  // Pushed the instant a device is Trusted in Settings, to a companion that
  // is already connected and sitting in the pendingApproval state - without
  // this, an already-connected pending companion would only learn it was
  // approved on its next reconnect, since it has no reason to re-send hello
  // and nothing else prompts the server to say anything in between.
  | { type: 'approved'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION }
  // pendingApproval marks a connection that authenticated with a real,
  // still-registered credential (fresh pairing, unattended registration, or
  // a previously-approved device not yet Trusted) but cannot dispatch calls
  // until a human approves it in Settings - distinct from a hard rejection
  // (dead/unknown credential), which closes the socket instead.
  | { type: 'pong'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; pendingApproval?: boolean }
  | { type: 'disconnect'; protocolVersion: typeof REMOTE_CUA_PROTOCOL_VERSION; reason: 'revoked' | 'disabled' };

export function isRemoteCuaMessage(value: unknown): value is RemoteCuaMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return typeof message.type === 'string' && message.protocolVersion === REMOTE_CUA_PROTOCOL_VERSION;
}
