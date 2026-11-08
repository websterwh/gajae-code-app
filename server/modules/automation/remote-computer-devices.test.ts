import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteComputerDeviceRegistry } from './remote-computer-devices.js';

function storage() {
  const values = new Map<string, string>();
  return { values, get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => values.set(key, value) };
}

test('pairing tokens expire, consume once, and never persist credentials', () => {
  let now = 100;
  const values = storage();
  const registry = new RemoteComputerDeviceRegistry(values, () => now);
  const pairing = registry.issuePairing();
  const paired = registry.consumePairing(pairing.token, 'Laptop', 'linux');
  // A manually-issued token already proves the approval step (copied out
  // of this server's own Settings page), so a token-paired device starts
  // enabled immediately, unlike an unattended --server-only registration.
  assert.equal(paired.device.enabled, true);
  assert.equal(JSON.stringify([...values.values.values()]).includes(paired.credential), false);
  assert.throws(() => registry.consumePairing(pairing.token, 'Laptop', 'linux'), /invalid, expired, or already used/u);
  const expired = registry.issuePairing(); now += 10 * 60_001;
  assert.throws(() => registry.consumePairing(expired.token, 'Laptop', 'linux'), /invalid, expired, or already used/u);
});

test('a token-paired device authenticates immediately; an untrusted one is not-yet-approved, not dead', () => {
  const registry = new RemoteComputerDeviceRegistry(storage());
  const paired = registry.consumePairing(registry.issuePairing().token, 'Laptop', 'linux');
  assert.equal(registry.authenticate(paired.device.id, paired.credential).id, paired.device.id);
  registry.update(paired.device.id, { enabled: false });
  assert.throws(() => registry.authenticate(paired.device.id, paired.credential), /not-yet-approved/u);
  registry.update(paired.device.id, { enabled: true });
  assert.equal(registry.authenticate(paired.device.id, paired.credential).id, paired.device.id);
  registry.select(paired.device.id);
  registry.revoke(paired.device.id);
  assert.equal(registry.selectedDeviceId(), undefined);
  assert.throws(() => registry.dispatchable(paired.device.id), /unavailable/u);
  assert.throws(() => registry.authenticate(paired.device.id, paired.credential), /device-not-registered/u);
});

test('registerUnattended creates a disabled device without a pairing token', () => {
  const registry = new RemoteComputerDeviceRegistry(storage());
  const registered = registry.registerUnattended('Desktop', 'linux');
  assert.equal(registered.device.enabled, false);
  assert.throws(() => registry.authenticate(registered.device.id, registered.credential), /not-yet-approved/u);
  registry.update(registered.device.id, { enabled: true });
  assert.equal(registry.authenticate(registered.device.id, registered.credential).id, registered.device.id);
});

test('removing a device actually drops it from the list, not just marks it revoked', () => {
  const registry = new RemoteComputerDeviceRegistry(storage());
  const paired = registry.consumePairing(registry.issuePairing().token, 'Laptop', 'linux');
  assert.equal(registry.list().length, 1);
  registry.revoke(paired.device.id);
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.update(paired.device.id, { enabled: true }), /was not found/u);
  assert.throws(() => registry.revoke(paired.device.id), /was not found/u);
});
