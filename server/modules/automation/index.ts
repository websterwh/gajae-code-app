export {
  authenticateAutomation,
  authenticateAutomationDeviceRequest,
  createAutomationAuth,
  deviceCredentialFrom,
  isAutomationPath,
} from './automation-auth.js';
export {
  default as automationRoutes,
  createAutomationRouter,
  createBrowserAutomationRouter,
} from './automation.routes.js';
export {
  automationService, AutomationService, configureDesktopRestartAdmission,
  createAutomationDesktopRestartReader, createBrowserDesktopRestartReader, createComputerDesktopRestartReader,
} from './automation.service.js';
export { BrowserBackendStore, browserBackendStore, resolveGjcBrowserBackend } from './browser-backend.js';
export {
  EgoActivityReader, EgoActivityStore, egoActivityReader, egoActivityStore,
  type EgoActivityResponse,
} from './ego-activity.js';
export { AGENT_DESKTOP_SAFE_TOOLS, type AgentDesktopSafeTool } from './agent-desktop-tools.js';
export { RemoteComputerTransport, type ComputerTransport } from './computer-transport.js';
export { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';
export type { BrowserCommand, BrowserSessionState } from './browser-protocol.js';
