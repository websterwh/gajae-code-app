import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { normalizeIssuer, oidcEnforcing, validateOidcConfig, type OidcConfig } from './oidc.config.js';
import { isExemptPath } from './oidc.middleware.js';
import {
  buildAuthorizeUrl,
  completeSignIn,
  createTransaction,
  discoverOidc,
  identityAllowed,
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
  allowedDomains: [],
  allowedEmails: [],
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

test('email gates allow by list, by domain, or not at all', () => {
  const base = configFor('https://auth.example.com');
  const identity = { sub: 's', email: 'owner@example.com', emailVerified: true };
  assert.equal(identityAllowed(base, identity), true);
  assert.equal(identityAllowed({ ...base, allowedDomains: ['example.com'] }, identity), true);
  assert.equal(identityAllowed({ ...base, allowedDomains: ['other.com'] }, identity), false);
  assert.equal(identityAllowed({ ...base, allowedEmails: ['owner@example.com'] }, identity), true);
  assert.equal(identityAllowed(base, { ...identity, emailVerified: false }), false);
});

test('the gate is inert until the config is complete, and exempts automation', () => {
  assert.equal(oidcEnforcing({ ...configFor('https://a.example'), clientSecret: '' }), false);
  assert.equal(oidcEnforcing(configFor('https://a.example')), true);
  assert.equal(validateOidcConfig({ ...configFor('http://insecure.example') }), 'The issuer must use https.');
  assert.equal(validateOidcConfig(configFor('http://localhost:8080')), null);

  for (const path of ['/health', '/api/auth/oidc/start', '/api/gjc/jobs', '/api/automation/computer', '/api/browser/cdp', '/ws', '/assets/index-abc.js']) {
    assert.equal(isExemptPath(path), true, `${path} must stay reachable`);
  }
  for (const path of ['/', '/api/providers/sessions', '/api/settings']) {
    assert.equal(isExemptPath(path), false, `${path} must require a session`);
  }
});
