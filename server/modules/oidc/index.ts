/**
 * Public surface of the OIDC module. Cross-module imports must come through
 * here, so the router and the gate are named in one place.
 */
export { createOidcRouter } from './oidc.routes.js';
export {
  OIDC_EXEMPT_PREFIXES,
  clientAddress,
  clientAddressAllowed,
  coversLocalBypass,
  createOidcGate,
  isExemptPath,
  noAuthEnabled,
  type OidcGateOptions,
} from './oidc.middleware.js';
export {
  DEFAULT_LOCAL_RANGES,
  OIDC_REDIRECT_PATH,
  oidcEnforcing,
  readOidcConfig,
  publicOidcConfig,
  resolvedAllowedIps,
  writeOidcConfig,
  type OidcConfig,
} from './oidc.config.js';
export { hasSessionCookie, readSession } from './oidc.sessions.js';
