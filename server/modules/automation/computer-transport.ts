import { isAgentDesktopSafeTool, type AgentDesktopStatus, type AgentDesktopClient } from './agent-desktop-client.js';
import type { ComputerTool } from './local-machine-capability.js';
import type { RemoteComputerHub } from './remote-computer-hub.js';

/**
 * The narrow transport seam below the app-owned agent-desktop authority.
 * Policy, grants, target resolution, and run binding remain above this
 * interface.
 */
export interface ComputerTransport {
  call(appSessionId: string, tool: ComputerTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  status(): Promise<AgentDesktopStatus>;
}

export class LocalComputerTransport implements ComputerTransport {
  constructor(private readonly client: AgentDesktopClient) {}
  call(_appSessionId: string, tool: ComputerTool, args: Record<string, unknown>, signal?: AbortSignal) {
    // local_* tools run on the paired companion's machine; this server can
    // never satisfy them, so say so instead of falling through to the driver.
    if (!isAgentDesktopSafeTool(tool)) {
      return Promise.reject(new Error(`${tool} runs on the machine with the paired companion, not on this server. Pair a companion started with --shell to use it.`));
    }
    return this.client.call(tool, args, signal);
  }
  status() { return this.client.status(); }
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
