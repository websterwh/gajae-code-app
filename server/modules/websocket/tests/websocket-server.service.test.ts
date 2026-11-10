import assert from 'node:assert/strict';
import test from 'node:test';

import { isEncryptedRemoteCuaUpgrade } from '@/modules/websocket/services/websocket-server.service.js';

/*
 * The /remote-cua upgrade exchanges a device's long-lived credential, so it
 * must run over an actually-encrypted transport. A reverse proxy terminating
 * TLS and forwarding plain HTTP is a normal, secure deployment shape and must
 * still be accepted - but x-forwarded-proto is attacker-controllable on any
 * request that reaches this process directly, so it counts only when the peer
 * that sent it is local.
 */

const PROXY = '172.18.0.2';
const PUBLIC_CLIENT = '203.0.113.9';

const upgrade = (headers: Record<string, string>, encrypted = false, remoteAddress = PROXY) => ({
  req: { headers, socket: { encrypted, remoteAddress } },
});

test('a directly encrypted socket is accepted with no configuration', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'gjc.example' }, true), {}), true);
});

test('plain HTTP in production is rejected', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'gjc.example' }), { nodeEnv: 'production' }), false);
});

test('localhost plain HTTP is accepted outside production only', () => {
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: 'localhost' }), {}), true);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade({ host: '127.0.0.1' }), { nodeEnv: 'production' }), false);
});

test('a TLS-terminating proxy on this network may vouch for https', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), { nodeEnv: 'production' }), true);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers, false, '127.0.0.1'), {}), true);
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers, false, '::ffff:192.168.1.2'), {}), true);
});

test('the same header from a remote peer is just something the client wrote', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers, false, PUBLIC_CLIENT), {}), false);
});

test('a forwarded proto other than https is not encryption', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'http' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), {}), false);
});

test('a multi-hop forwarded-proto list is read from its first, closest-to-proxy entry', () => {
  const headers = { host: 'gjc.example', 'x-forwarded-proto': 'https, http' };
  assert.equal(isEncryptedRemoteCuaUpgrade(upgrade(headers), {}), true);
});
