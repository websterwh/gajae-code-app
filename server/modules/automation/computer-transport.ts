import type { AgentDesktopSafeTool, AgentDesktopStatus, AgentDesktopClient } from './agent-desktop-client.js';
import type { RemoteComputerHub } from './remote-computer-hub.js';

/**
 * The narrow transport seam below the app-owned agent-desktop authority.
 * Policy, grants, target resolution, and run binding remain above this
 * interface.
 */
export interface ComputerTransport {
  call(appSessionId: string, tool: AgentDesktopSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  status(): Promise<AgentDesktopStatus>;
}

export class LocalComputerTransport implements ComputerTransport {
  constructor(private readonly client: AgentDesktopClient) {}
  call(_appSessionId: string, tool: AgentDesktopSafeTool, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.client.call(tool, args, signal);
  }
  status() { return this.client.status(); }
}

export class RemoteComputerTransport implements ComputerTransport {
  constructor(private readonly deviceId: string, private readonly hub: RemoteComputerHub) {}
  call(appSessionId: string, tool: AgentDesktopSafeTool, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.hub.call(this.deviceId, appSessionId, tool, args, signal);
  }
  async status(): Promise<AgentDesktopStatus> {
    const readiness = this.hub.readiness(this.deviceId);
    return {
      installed: Boolean(readiness), version: readiness?.driverVersion, daemon: readiness?.daemon ?? 'unknown',
      schemaSupported: readiness?.schemaSupported,
    };
  }
}
