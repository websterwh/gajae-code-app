export { createHostControlRouter, default as hostControlRoutes } from './host-control.routes.js';
export {
  allowsHostCapability,
  allowsHostTarget,
  DEFAULT_HOST_CONTROL_SETTINGS,
  dockerSocketPath,
  HOST_CAPABILITIES,
  hostControlAvailable,
  isHostCapability,
  isTargetPattern,
  matchesHostTarget,
  parseTargets,
  readHostControlRunPolicy,
  readHostControlSettings,
  writeHostControlSettings,
} from './host-control.settings.js';
// The socket client, the exec verbs, the discovery tables and the capability
// vocabulary live beside the engine, because the worker's `host` tool uses them
// directly; the app reaches them only through the engine's published surface.
// This barrel is the app's host-control surface, so it forwards them.
export {
  CONTAINER_ACTIONS,
  dockerClient,
  DockerSocketError,
  describeExecVerbs,
  detectHost,
  EXEC_VERBS,
  findExecVerb,
  HOST_MANAGERS,
  HOST_PLATFORMS,
  isContainerAction,
  isContainerName,
} from '../../gjc-engine.js';
export type {
  ExecVerb,
  HostArchive,
  HostContainer,
  HostControlClient,
  HostInfo,
  HostManagerMatch,
  HostMount,
  HostPlatformKind,
  HostPlatformMatch,
  HostProfile,
  HostStack,
} from '../../gjc-engine.js';
export type { HostCapability, HostControlRunPolicy, HostControlSettings } from './host-control.settings.js';
