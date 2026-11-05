import type { CuaSafeTool, CuaStatus, CuaDriverClient } from './cua-client.js';
import type { RemoteComputerHub } from './remote-computer-hub.js';

/**
 * The narrow transport seam below the app-owned CUA authority. Policy, grants,
 * target resolution, and run binding remain above this interface.
 */
export interface ComputerTransport {
  call(appSessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  status(): Promise<CuaStatus>;
}

export class LocalComputerTransport implements ComputerTransport {
  constructor(private readonly client: CuaDriverClient) {}
  call(_appSessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.client.call(tool, args, signal);
  }
  status() { return this.client.status(); }
}

export class RemoteComputerTransport implements ComputerTransport {
  constructor(private readonly deviceId: string, private readonly hub: RemoteComputerHub) {}
  call(appSessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.hub.call(this.deviceId, appSessionId, tool, args, signal);
  }
  async status(): Promise<CuaStatus> {
    const readiness = this.hub.readiness(this.deviceId);
    return {
      installed: Boolean(readiness), version: readiness?.driverVersion, daemon: readiness?.daemon ?? 'unknown',
      accessibility: readiness?.accessibility, screenRecording: readiness?.screenRecording,
      schemaSupported: readiness?.schemaSupported,
    };
  }
}
