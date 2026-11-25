export {
  adoptAgentInstalledPackagesFromTranscript,
  adoptAgentPackageInstalls,
  installCommandsFromTranscript,
  parseInstallCommands,
  splitShellSegments,
  type AdoptAgentPackagesOptions,
  type AgentPackageInstall,
  type AgentPackageManager,
} from './agent-packages.service.js';
export { createMcpRouter, default as mcpRoutes } from './mcp.routes.js';
export { McpService, mcpService, type McpServerView, type VerifyResult } from './mcp.service.js';
export {
  REDACTED,
  agentDir,
  readMcpConfig,
  writeMcpConfig,
  type McpFile,
  type McpScope,
  type McpServerEntry,
  type PublicMcpServer,
} from './mcp.config.js';
export {
  INSTALL_MANAGERS,
  emptyLedger,
  failedEntries,
  ledgerFilePath,
  readLedger,
  recordFailure,
  recordInstalled,
  writeLedger,
  type InstallManager,
  type Ledger,
  type LedgerEntry,
  type LedgerStatus,
} from './ledger.js';
export { isDowngrade, normalizePin, parsePackageSpec, pinnedSpec, shouldAutoUpdate } from './pins.js';
export {
  autoUpdatePackages,
  installCommand,
  parseInstalledVersion,
  provisionPackages,
  spawnCommandRunner,
  uninstallCommand,
  uninstallPackage,
  upgradePackage,
  verifyCommand,
  type CommandRunner,
  type ProvisionOutcome,
  type UninstallOutcome,
} from './provision.js';
export { provisionStateIsLive, provisionStatePath, readProvisionState, writeProvisionState, type ProvisionState } from './provision-state.js';
export {
  ENV_PACKAGE_VARIABLES,
  desiredPackagesPath,
  emptyDesired,
  envSeeds,
  readDesired,
  removeDesired,
  upsertDesired,
  writeDesired,
  type DesiredPackage,
  type DesiredState,
  type EnvSeed,
} from './desired.js';
