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
  assert.equal(paired.device.enabled, false);
  assert.equal(JSON.stringify([...values.values.values()]).includes(paired.credential), false);
  assert.throws(() => registry.consumePairing(pairing.token, 'Laptop', 'linux'), /invalid, expired, or already used/u);
  const expired = registry.issuePairing(); now += 10 * 60_001;
  assert.throws(() => registry.consumePairing(expired.token, 'Laptop', 'linux'), /invalid, expired, or already used/u);
});

test('disabled and revoked devices cannot authenticate or be selected', () => {
  const registry = new RemoteComputerDeviceRegistry(storage());
  const paired = registry.consumePairing(registry.issuePairing().token, 'Laptop', 'linux');
  assert.throws(() => registry.authenticate(paired.device.id, paired.credential), /unavailable/u);
  registry.update(paired.device.id, { enabled: true });
  assert.equal(registry.authenticate(paired.device.id, paired.credential).id, paired.device.id);
  registry.select(paired.device.id);
  registry.revoke(paired.device.id);
  assert.equal(registry.selectedDeviceId(), undefined);
  assert.throws(() => registry.dispatchable(paired.device.id), /unavailable/u);
});
