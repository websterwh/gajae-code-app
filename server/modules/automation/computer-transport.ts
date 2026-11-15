import type { AgentDesktopStatus } from './agent-desktop-tools.js';
import type { ComputerTool } from './local-machine-capability.js';
import type { RemoteComputerHub } from './remote-computer-hub.js';

/**
 * The narrow transport seam below the app-owned agent-desktop authority.
 * Policy, grants, target resolution, and run binding remain above this
 * interface. The only implementation is the paired companion; this server
 * never drives a desktop of its own.
 */
export interface ComputerTransport {
  call(appSessionId: string, tool: ComputerTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  status(): Promise<AgentDesktopStatus>;
}

export class RemoteComputerTransport implements ComputerTransport {
  constructor(private readonly deviceId: string, private readonly hub: RemoteComputerHub) {}
  call(appSessionId: string, tool: ComputerTool, args: Record<string, unknown>, signal?: AbortSignal) {
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
