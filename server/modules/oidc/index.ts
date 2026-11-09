/**
 * Public surface of the OIDC module. Cross-module imports must come through
 * here, so the router and the gate are named in one place.
 */
export { createOidcRouter } from './oidc.routes.js';
export { OIDC_EXEMPT_PREFIXES, createOidcGate, isExemptPath } from './oidc.middleware.js';
export { OIDC_REDIRECT_PATH, oidcEnforcing, readOidcConfig, publicOidcConfig, writeOidcConfig } from './oidc.config.js';
