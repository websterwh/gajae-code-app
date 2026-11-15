import type { NextFunction, Request, Response } from 'express';

import { isDesktopMode } from '@/middleware/desktop-auth.js';
import {
  clientAddress,
  clientAddressAllowed,
  coversLocalBypass,
  hasSessionCookie,
  noAuthEnabled,
  oidcEnforcing,
  readOidcConfig,
  type OidcConfig,
} from '@/modules/oidc/index.js';

import { automationService } from './automation.service.js';

export const DEVICE_ID_HEADER = 'x-gajae-device-id';
export const DEVICE_CREDENTIAL_HEADER = 'x-gajae-device-credential';

type CredentialClaim = { deviceId: string; credential: string };
type CredentialRegistry = { verifyLiveCredential(deviceId: string, credential: string): boolean };

function first(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * The device a request targets and the credential it presents. Headers are the
 * normal channel; query parameters are accepted because a browser EventSource
 * (the device-list stream) cannot set headers on its first request.
 */
export function deviceCredentialFrom(request: {
  headers: Record<string, unknown>;
  query?: unknown;
}): CredentialClaim | null {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const deviceId = first(request.headers[DEVICE_ID_HEADER]) || first(query.deviceId);
  const credential = first(request.headers[DEVICE_CREDENTIAL_HEADER]) || first(query.credential);
  return deviceId && credential ? { deviceId, credential } : null;
}

/** The two surfaces that dispatch into a paired companion. */
export function isAutomationPath(pathname: string): boolean {
  return pathname === '/api/automation' || pathname.startsWith('/api/automation/')
    || pathname === '/api/browser' || pathname.startsWith('/api/browser/');
}

export type AutomationAuthDependencies = {
  registry?: CredentialRegistry;
  readConfig?: () => OidcConfig;
  hasSession?: (cookieHeader: string | undefined) => boolean;
  isDesktop?: () => boolean;
  noAuth?: () => boolean;
};

/**
 * Authentication for the automation and browser routers.
 *
 * With sign-in enforced a caller needs a session or a live paired-device
 * credential for the device it targets. When the gate is inert the previous
 * open behaviour is preserved, and the boot log names the exposure. The same
 * helper backs the gate's `authenticateRequest` hook, so a credential that
 * opens `/api/automation` is exactly the credential the hub accepts.
 */
export function createAutomationAuth(dependencies: AutomationAuthDependencies = {}) {
  const registry = dependencies.registry ?? automationService.remoteDevices;
  const readConfig = dependencies.readConfig ?? readOidcConfig;
  const sessionPresent = dependencies.hasSession ?? hasSessionCookie;
  const desktop = dependencies.isDesktop ?? isDesktopMode;
  const breakGlass = dependencies.noAuth ?? noAuthEnabled;

  const credentialIsLive = (request: Request): boolean => {
    const claim = deviceCredentialFrom(request);
    return Boolean(claim && registry.verifyLiveCredential(claim.deviceId, claim.credential));
  };

  const deviceRequest = (request: Request): boolean => isAutomationPath(request.path) && credentialIsLive(request);

  const middleware = (request: Request, response: Response, next: NextFunction) => {
    const config = readConfig();
    if (desktop() || !oidcEnforcing(config) || breakGlass()) return next();
    if (sessionPresent(request.headers.cookie)) return next();
    if (config.allowLocal && coversLocalBypass(request.path)
      && clientAddressAllowed(clientAddress(request), config.allowedIps)) return next();
    if (credentialIsLive(request)) return next();
    return response.status(401).json({
      success: false,
      error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in or present a paired device credential.' },
    });
  };

  return { middleware, deviceRequest };
}

const automationAuth = createAutomationAuth();

export const authenticateAutomation = automationAuth.middleware;
export const authenticateAutomationDeviceRequest = automationAuth.deviceRequest;
