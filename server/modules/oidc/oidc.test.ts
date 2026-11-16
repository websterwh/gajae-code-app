import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { normalizeIssuer, oidcEnforcing, resolvedAllowedIps, validateOidcConfig, type OidcConfig } from './oidc.config.js';
import {
  OIDC_EXEMPT_PREFIXES,
  clientAddress,
  clientAddressAllowed,
  coversLocalBypass,
  isExemptPath,
  noAuthEnabled,
  requiresSession,
} from './oidc.middleware.js';
import {
  buildAuthorizeUrl,
  completeSignIn,
  createTransaction,
  discoverOidc,
  identityAllowed,
  identityRejection,
} from './oidc.provider.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** Minimal provider: discovery, JWKS and a token endpoint that mints an id_token. */
function startIssuer(claims: Record<string, unknown>): Promise<{ issuer: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (request.url === '/.well-known/openid-configuration') {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }));
      }
      if (request.url === '/jwks') {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ keys: [jwk] }));
      }
      if (request.url === '/token') {
        const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
        const payload = encode({ iss: issuer, ...claims });
        const signer = createSign('RSA-SHA256');
        signer.update(`${header}.${payload}`);
        const token = `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ id_token: token, token_type: 'Bearer' }));
      }
      response.statusCode = 404;
      return response.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({
      issuer: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      server,
    }));
  });
}

const configFor = (issuer: string): OidcConfig => ({
  enabled: true,
  issuer: normalizeIssuer(issuer),
  clientId: 'gajae-test',
  clientSecret: 'secret',
  scopes: 'openid profile email',
  redirectUri: '',
  allowedGroups: [],
  allowLocal: false,
  allowedIps: [],
});

const future = () => Math.floor(Date.now() / 1000) + 300;

test('discovery reads the provider document and rejects an issuer mismatch', async () => {
  const { issuer, server } = await startIssuer({});
  try {
    const discovery = await discoverOidc(issuer, true);
    assert.equal(discovery.issuer, normalizeIssuer(issuer));
    assert.equal(discovery.authorization_endpoint, `${issuer}/authorize`);
    assert.equal(discovery.jwks_uri, `${issuer}/jwks`);

    const wrong = await startIssuer({});
    const error = await discoverOidc(`${normalizeIssuer(issuer)}/nope`, true).then(() => null, (e: Error) => e);
    wrong.server.close();
    assert.ok(error, 'a document whose issuer differs must be rejected');
  } finally {
    server.close();
  }
});

test('an RS256 id_token is verified end to end', async () => {
  const nonce = 'nonce-value';
  const { issuer, server } = await startIssuer({
    aud: 'gajae-test', sub: 'subject-1', email: 'Owner@Example.com',
    email_verified: true, nonce, exp: future(),
  });
  try {
    const config = configFor(issuer);
    const discovery = await discoverOidc(issuer, true);
    const identity = await completeSignIn(config, discovery, {
      code: 'code', redirectUri: `${issuer}/callback`, codeVerifier: 'verifier', nonce,
    });
    assert.equal(identity.sub, 'subject-1');
    assert.equal(identity.email, 'owner@example.com');
    assert.equal(identity.emailVerified, true);
  } finally {
    server.close();
  }
});

test('a mismatched nonce, audience or issuer is refused before claims are used', async () => {
  const cases = [
    { claim: { nonce: 'other', exp: future(), aud: 'gajae-test', sub: 's', email: 'a@b.c' } },
    { claim: { nonce: 'n', exp: future(), aud: 'someone-else', sub: 's', email: 'a@b.c' } },
    { claim: { nonce: 'n', exp: 1, aud: 'gajae-test', sub: 's', email: 'a@b.c' } },
  ];
  for (const { claim } of cases) {
    const { issuer, server } = await startIssuer(claim);
    try {
      const config = configFor(issuer);
      const discovery = await discoverOidc(issuer, true);
      const failure = await completeSignIn(config, discovery, {
        code: 'c', redirectUri: `${issuer}/cb`, codeVerifier: 'v', nonce: 'n',
      }).then(() => null, (error: Error) => error);
      assert.ok(failure, `expected rejection for ${JSON.stringify(claim)}`);
    } finally {
      server.close();
    }
  }
});

test('the authorize URL carries PKCE, state and nonce', () => {
  const config = configFor('https://auth.example.com');
  const url = new URL(buildAuthorizeUrl(config, {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    jwks_uri: 'https://auth.example.com/jwks',
  }, createTransaction('https://app.example.com/api/auth/oidc/callback'), 'https://app.example.com/api/auth/oidc/callback'));

  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'gajae-test');
  assert.match(String(url.searchParams.get('scope')), /\bopenid\b/u);
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('nonce'));
  assert.ok(url.searchParams.get('code_challenge'));
});

test('an empty allowed-group list admits nobody, and the provider flag is still not the gate', () => {
  const base = configFor('https://auth.example.com');
  const identity = { sub: 's', email: 'owner@example.com', emailVerified: true, groups: ['gajae-admins'] };
  assert.equal(identityAllowed(base, identity), false);
  assert.match(String(identityRejection(base, identity)), /allowed group/u);
  // The provider's flag is reported, not decisive: Pocket ID leaves it unset for
  // accounts it creates, and the group is what decides.
  assert.equal(identityAllowed({ ...base, allowedGroups: ['gajae-admins'] }, { ...identity, emailVerified: false }), true);
});

test('groups gate sign-in and every configured list has to pass', () => {
  const base = configFor('https://auth.example.com');
  const identity = { sub: 's', email: 'owner@example.com', emailVerified: true, groups: ['Gajae-Admins'] };
  assert.equal(identityAllowed({ ...base, allowedGroups: ['gajae-admins'] }, identity), true);
  assert.equal(identityAllowed({ ...base, allowedGroups: ['other'] }, identity), false);
  assert.equal(identityAllowed({ ...base, allowedGroups: ['other'] }, { ...identity, groups: [] }), false);
});

test('a rejection names the gate that refused the identity', () => {
  const base = { ...configFor('https://auth.example.com'), allowedGroups: ['staff'] };
  const identity = { sub: 's', email: 'owner@example.com', emailVerified: true, groups: ['staff'] };
  assert.equal(identityRejection(base, identity), null);
  assert.match(String(identityRejection({ ...base, allowedGroups: ['admins'] }, identity)), /staff/u);
  assert.match(String(identityRejection({ ...base, allowedGroups: ['admins'] }, { ...identity, groups: [] })), /no groups/u);
});

test('NO_AUTH is the deliberate break-glass switch, and the bind-guard var is not', () => {
  const savedNoAuth = process.env.NO_AUTH;
  const savedPrefixed = process.env.GAJAE_NO_AUTH;
  const savedGuard = process.env.GAJAE_ALLOW_UNAUTH_REMOTE;
  try {
    delete process.env.NO_AUTH;
    delete process.env.GAJAE_NO_AUTH;
    // Container images ship this as 1 for the bind guard; it must not switch
    // sign-in off for deployments that never asked for that.
    process.env.GAJAE_ALLOW_UNAUTH_REMOTE = '1';
    assert.equal(noAuthEnabled(), false);
    process.env.NO_AUTH = 'true';
    assert.equal(noAuthEnabled(), true);
    delete process.env.NO_AUTH;
    process.env.GAJAE_NO_AUTH = 'true';
    assert.equal(noAuthEnabled(), true);
    process.env.GAJAE_NO_AUTH = 'false';
    assert.equal(noAuthEnabled(), false);
    // `1` stays accepted for deployments written before true/false.
    process.env.GAJAE_NO_AUTH = '1';
    assert.equal(noAuthEnabled(), true);
  } finally {
    if (savedNoAuth === undefined) delete process.env.NO_AUTH; else process.env.NO_AUTH = savedNoAuth;
    if (savedPrefixed === undefined) delete process.env.GAJAE_NO_AUTH; else process.env.GAJAE_NO_AUTH = savedPrefixed;
    if (savedGuard === undefined) delete process.env.GAJAE_ALLOW_UNAUTH_REMOTE;
    else process.env.GAJAE_ALLOW_UNAUTH_REMOTE = savedGuard;
  }
});

test('a forwarded header is believed only when the peer that sent it is local', () => {
  const request = (socket: string, forwarded?: string, ip?: string) => ({
    socket: { remoteAddress: socket },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    ip,
  });
  // A proxy on the host or the container network speaks for the client.
  assert.equal(clientAddress(request('172.18.0.2', '8.8.8.8', '8.8.8.8')), '8.8.8.8');
  assert.equal(clientAddress(request('127.0.0.1', '192.168.1.40', '192.168.1.40')), '192.168.1.40');
  // A direct connection to the published port can write any header it likes.
  assert.equal(clientAddress(request('203.0.113.9', '192.168.1.40', '192.168.1.40')), '203.0.113.9');
  assert.equal(clientAddress(request('192.168.1.9')), '192.168.1.9');
  assert.equal(clientAddress(request('::ffff:192.168.1.9')), '192.168.1.9');
});

test('local access is granted per address, and defaults to private ranges', () => {
  assert.equal(clientAddressAllowed('127.0.0.1', []), true);
  assert.equal(clientAddressAllowed('::1', []), true);
  assert.equal(clientAddressAllowed('::ffff:192.168.1.40', []), true);
  assert.equal(clientAddressAllowed('172.20.0.3', []), true);
  assert.equal(clientAddressAllowed('8.8.8.8', []), false);

  assert.equal(clientAddressAllowed('192.168.1.40', ['192.168.1.0/24']), true);
  assert.equal(clientAddressAllowed('192.168.2.40', ['192.168.1.0/24']), false);
  assert.equal(clientAddressAllowed('10.0.0.5', ['192.168.1.0/24', '10.0.0.5']), true);
  assert.equal(clientAddressAllowed('8.8.8.8', ['192.168.1.0/24']), false);
  assert.equal(clientAddressAllowed('192.168.1.40', ['0.0.0.0/0']), true);

  assert.match(String(validateOidcConfig({ ...configFor('https://a.example'), allowedGroups: ['admins'], allowedIps: ['999.1.1.1'] })), /not an IP/u);
  assert.equal(validateOidcConfig({ ...configFor('https://a.example'), allowedGroups: ['admins'], allowedIps: ['192.168.1.0/24'] }), null);
  assert.equal(validateOidcConfig({ ...configFor('https://a.example'), allowedGroups: ['admins'], allowedIps: ['fc00::/7'] }), null);
  // Sign-in with no group list would admit every account the provider signs in.
  assert.match(String(validateOidcConfig(configFor('https://a.example'))), /allowed group/u);
});

test('the local bypass reports the ranges it actually grants', () => {
  const base = configFor('https://a.example');
  // Empty allowedIps is the default set, not "nothing". These are the values
  // the settings tab shows and the boot log prints.
  assert.deepEqual(resolvedAllowedIps(base), [
    '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7',
  ]);
  for (const address of ['127.0.0.1', '::1', '10.0.0.5', '172.20.0.3', '192.168.1.40', 'fc00::1']) {
    assert.equal(clientAddressAllowed(address, resolvedAllowedIps(base)), true, address);
  }
  assert.equal(clientAddressAllowed('8.8.8.8', resolvedAllowedIps(base)), false);
  assert.deepEqual(resolvedAllowedIps({ ...base, allowedIps: ['192.168.1.0/24'] }), ['192.168.1.0/24']);
});

test('the gate is inert until the config is complete, and the exemption list is exactly the intended set', () => {
  assert.equal(oidcEnforcing({ ...configFor('https://a.example'), clientSecret: '' }), false);
  assert.equal(oidcEnforcing(configFor('https://a.example')), true);
  assert.equal(validateOidcConfig({ ...configFor('http://insecure.example') }), 'The issuer must use https.');
  assert.equal(validateOidcConfig({ ...configFor('http://localhost:8080'), allowedGroups: ['admins'] }), null);

  for (const path of ['/health', '/api/auth/oidc/start', '/api/gjc/jobs', '/ws', '/.well-known/openid-configuration', '/assets/index-abc.js']) {
    assert.equal(isExemptPath(path), true, `${path} must stay reachable`);
  }
  // An extension is not an exemption: chat images are served from /api and must
  // still require the session that uploaded them.
  assert.equal(isExemptPath('/api/assets/images/abc123.png'), false);
  assert.equal(isExemptPath('/api/projects/1/file/secret.txt'), false);
  // Every new surface is authenticated by default: automation dispatches into a
  // paired companion, browser drives CDP, and MCP mutates the agent's config.
  // A future feature cannot quietly join this list.
  for (const path of ['/', '/api/providers/sessions', '/api/settings', '/api/host/containers', '/api/automation/computer', '/api/browser/cdp', '/api/mcp/servers']) {
    assert.equal(isExemptPath(path), false, `${path} must require a session`);
  }
  assert.deepEqual([...OIDC_EXEMPT_PREFIXES], [
    '/health', '/api/auth', '/api/gjc', '/api/desktop', '/ws', '/.well-known',
  ]);
  // A trusted LAN address may read the app without signing in, but it never
  // reaches host control that way.
  for (const path of ['/api/host', '/api/host/containers', '/api/host/containers/app/restart']) {
    assert.equal(requiresSession(path), true, `${path} must not skip sign-in for local addresses`);
  }
  for (const path of ['/api/settings', '/api/hostile']) {
    assert.equal(requiresSession(path), false, path);
  }
  // The deployment's own opt-in is what lets the bypass cover host control:
  // the variable is set in the container environment, never by a request, and
  // without it every /api/host route is inert, so a sign-in would protect
  // nothing but would lock the operator out of the switch they just enabled.
  assert.equal(coversLocalBypass('/api/settings', {}), true);
  assert.equal(coversLocalBypass('/api/host/status', {}), false);
  assert.equal(coversLocalBypass('/api/host/status', { GAJAE_HOST_CONTROL: '0' }), false);
  assert.equal(coversLocalBypass('/api/host/status', { GAJAE_HOST_CONTROL: '1' }), true);
  assert.equal(coversLocalBypass('/api/host/status', { GAJAE_HOST_CONTROL: 'true' }), true);
  assert.equal(coversLocalBypass('/api/host/status', { GAJAE_HOST_CONTROL: 'false' }), false);
});
