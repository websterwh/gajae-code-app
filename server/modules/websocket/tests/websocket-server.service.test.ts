import assert from 'node:assert/strict';
import test from 'node:test';

import { isEncryptedRemoteCuaUpgrade } from '@/modules/websocket/services/websocket-server.service.js';

/*
 * The /remote-cua upgrade exchanges a device's long-lived credential, so it
 * must run over an actually-encrypted transport. A reverse proxy terminating
 * TLS and forwarding plain HTTP is a normal, secure deployment shape and must
 * not be rejected - but x-forwarded-proto is attacker-controllable on any
 * request that reaches this process directly, so it must never be trusted
 * without an explicit deployer opt-in.
 */

const upgrade = (headers: Record<string, string>, encrypted = false) => ({
  req: { headers, socket: { encrypted } },
});

test('a directly encrypted socket is accepted with no configuration', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'gjc.example' }, true), {}), true);
});

test('plain HTTP in production with no proxy trust is rejected', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'gjc.example' }), { nodeEnv: 'production' }), false);
});

test('localhost plain HTTP is accepted outside production only', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'localhost' }), {}), true);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: '127.0.0.1' }), { nodeEnv: 'production' }), false);
});

test('x-forwarded-proto is ignored without the explicit trust-proxy opt-in', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), {}), false);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { nodeEnv: 'production' }), false);
});

test('x-forwarded-proto is honored once the deployer opts in with GAJAE_TRUST_PROXY_TLS', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { trustProxyTls: '1' }), true);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { trustProxyTls: 'true' }), true);
});

test('opting in still rejects a forwarded-proto value other than https', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'http' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { trustProxyTls: '1' }), false);
});

test('a multi-hop forwarded-proto list is read from its first, closest-to-proxy entry', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https, http' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { trustProxyTls: '1' }), true);
});
