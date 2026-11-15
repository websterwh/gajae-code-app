import assert from 'node:assert/strict';
import test from 'node:test';

import type { OidcConfig } from '@/modules/oidc/index.js';

import {
  createAutomationAuth,
  deviceCredentialFrom,
  isAutomationPath,
} from './automation-auth.js';

const enforcing = (overrides: Partial<OidcConfig> = {}): OidcConfig => ({
  enabled: true,
  issuer: 'https://auth.example.com',
  clientId: 'gajae-test',
  clientSecret: 'secret',
  scopes: 'openid',
  redirectUri: '',
  allowedGroups: [],
  allowLocal: false,
  allowedIps: [],
  ...overrides,
});

type RequestShape = {
  path: string;
  headers: Record<string, unknown>;
  query?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
};

function request(overrides: Partial<RequestShape> = {}): RequestShape {
  return {
    path: '/api/automation/computer/session-a/call',
    headers: {},
    query: {},
    socket: { remoteAddress: '203.0.113.5' },
    ...overrides,
  };
}

function harness(options: {
  config?: OidcConfig;
  live?: boolean;
  session?: boolean;
  desktop?: boolean;
  noAuth?: boolean;
} = {}) {
  return createAutomationAuth({
    registry: { verifyLiveCredential: () => options.live === true },
    readConfig: () => options.config ?? enforcing(),
    hasSession: () => options.session === true,
    isDesktop: () => options.desktop === true,
    noAuth: () => options.noAuth === true,
  });
}

function invoke(auth: ReturnType<typeof harness>, shape: RequestShape) {
  let status: number | undefined;
  let body: unknown;
  let passed = false;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  auth.middleware(shape as never, response as never, () => { passed = true; });
  return { passed, status, body };
}

test('an enforcing gate rejects automation and browser callers with no session or credential', () => {
  for (const path of ['/api/automation/status', '/api/automation/computer/s/call', '/api/browser/s/open']) {
    const result = invoke(harness(), request({ path }));
    assert.equal(result.passed, false, path);
    assert.equal(result.status, 401, path);
  }
});

test('a session, a live device credential, or the desktop shell is admitted', () => {
  assert.equal(invoke(harness({ session: true }), request()).passed, true);
  assert.equal(invoke(harness({ live: true }), request({
    headers: { 'x-gajae-device-id': 'device-1', 'x-gajae-device-credential': 'credential-1' },
  })).passed, true);
  assert.equal(invoke(harness({ desktop: true }), request()).passed, true);
});

test('the device credential is accepted from query parameters for EventSource', () => {
  assert.equal(invoke(harness({ live: true }), request({
    path: '/api/automation/remote-computers/events',
    query: { deviceId: 'device-1', credential: 'credential-1' },
  })).passed, true);
});

test('an inert gate keeps the previous open behaviour, and NO_AUTH does too', () => {
  assert.equal(invoke(harness({ config: enforcing({ enabled: false }) }), request()).passed, true);
  assert.equal(invoke(harness({ config: enforcing({ clientSecret: '' }) }), request()).passed, true);
  assert.equal(invoke(harness({ noAuth: true }), request()).passed, true);
});

test('the local bypass admits a trusted LAN address without a session', () => {
  const local = harness({ config: enforcing({ allowLocal: true }) });
  assert.equal(invoke(local, request({ socket: { remoteAddress: '192.168.1.40' } })).passed, true);
  assert.equal(invoke(local, request({ socket: { remoteAddress: '8.8.8.8' } })).passed, false);
});

test('the gate hook only speaks for the automation and browser paths', () => {
  const auth = harness({ live: true });
  const credentials = { 'x-gajae-device-id': 'device-1', 'x-gajae-device-credential': 'credential-1' };
  assert.equal(auth.deviceRequest(request({ headers: credentials }) as never), true);
  assert.equal(auth.deviceRequest(request({ path: '/api/browser/s/state', headers: credentials }) as never), true);
  assert.equal(auth.deviceRequest(request({ path: '/api/mcp/servers', headers: credentials }) as never), false);
  assert.equal(auth.deviceRequest(request({ path: '/api/automation/status' }) as never), false);
});

test('credential parsing ignores empty values and accepts arrays', () => {
  assert.deepEqual(deviceCredentialFrom({
    headers: { 'x-gajae-device-id': 'device-1', 'x-gajae-device-credential': 'credential-1' },
  }), { deviceId: 'device-1', credential: 'credential-1' });
  assert.equal(deviceCredentialFrom({ headers: { 'x-gajae-device-id': 'device-1' } }), null);
  assert.equal(deviceCredentialFrom({ headers: {} }), null);
  assert.equal(isAutomationPath('/api/automation'), true);
  assert.equal(isAutomationPath('/api/automation-other'), false);
});
