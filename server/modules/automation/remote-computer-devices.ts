import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { appConfigDb } from '@/modules/database/index.js';

import type { RemoteCuaReadiness } from '../../../shared/remote-cua-protocol.js';

const CONFIG_KEY = 'automation.remoteComputerDevices.v1';
const PAIRING_TTL_MS = 10 * 60_000;

export type RemoteComputerDevice = {
  id: string;
  name: string;
  os: string;
  enabled: boolean;
  revoked: boolean;
  credentialHash: string;
  publicIdentity: string;
  pairedAt: number;
  lastSeenAt?: number;
  readiness?: RemoteCuaReadiness;
};

type Pairing = { hash: string; expiresAt: number; used: boolean };
type Stored = { devices: RemoteComputerDevice[]; pairings: Pairing[]; selectedDeviceId?: string };
type Storage = Pick<typeof appConfigDb, 'get' | 'set'>;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function read(storage: Storage): Stored {
  try {
    const value = storage.get(CONFIG_KEY);
    if (!value) return { devices: [], pairings: [] };
    const parsed = JSON.parse(value) as Stored;
    return Array.isArray(parsed.devices) && Array.isArray(parsed.pairings) ? parsed : { devices: [], pairings: [] };
  } catch { return { devices: [], pairings: [] }; }
}
function publicDevice(device: RemoteComputerDevice): Omit<RemoteComputerDevice, 'credentialHash'> {
  const { credentialHash: _credentialHash, ...result } = device;
  return result;
}

/** Durable pairing and device state. Plain credentials are never persisted. */
export class RemoteComputerDeviceRegistry {
  constructor(private readonly storage: Storage = appConfigDb, private readonly now = () => Date.now()) {}
  private save(value: Stored): void { this.storage.set(CONFIG_KEY, JSON.stringify(value)); }

  list() { return read(this.storage).devices.map(publicDevice); }
  selectedDeviceId(): string | undefined { return read(this.storage).selectedDeviceId; }
  select(id: string | undefined): void {
    const state = read(this.storage);
    if (id && !state.devices.some(device => device.id === id && device.enabled && !device.revoked)) {
      throw new Error('Remote computer device is not enabled.');
    }
    state.selectedDeviceId = id;
    this.save(state);
  }
  issuePairing(): { token: string; expiresAt: number } {
    const state = read(this.storage);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PAIRING_TTL_MS;
    state.pairings = state.pairings.filter(pairing => pairing.expiresAt > this.now() && !pairing.used);
    state.pairings.push({ hash: hash(token), expiresAt, used: false });
    this.save(state);
    return { token, expiresAt };
  }
  consumePairing(token: string, name: string, os: string): { device: Omit<RemoteComputerDevice, 'credentialHash'>; credential: string } {
    const state = read(this.storage);
    const pairing = state.pairings.find(candidate => candidate.expiresAt > this.now() && !candidate.used
      && timingSafeEqual(Buffer.from(candidate.hash), Buffer.from(hash(token))));
    if (!pairing) throw new Error('Pairing token is invalid, expired, or already used.');
    pairing.used = true;
    const credential = randomBytes(32).toString('base64url');
    const device: RemoteComputerDevice = {
      id: randomUUID(), name: name.trim().slice(0, 100) || 'Remote computer', os: os.trim().slice(0, 100) || 'unknown',
      enabled: false, revoked: false, credentialHash: hash(credential), publicIdentity: randomBytes(32).toString('base64url'),
      pairedAt: this.now(),
    };
    state.devices.push(device);
    this.save(state);
    return { device: publicDevice(device), credential };
  }
  authenticate(id: string, credential: string): RemoteComputerDevice {
    const device = read(this.storage).devices.find(candidate => candidate.id === id);
    if (!device || device.revoked || !device.enabled || !credential
      || !timingSafeEqual(Buffer.from(device.credentialHash), Buffer.from(hash(credential)))) {
      throw new Error('Remote computer device is unavailable.');
    }
    return device;
  }
  dispatchable(id: string): RemoteComputerDevice {
    const device = read(this.storage).devices.find(candidate => candidate.id === id);
    if (!device || device.revoked || !device.enabled) throw new Error('Remote computer device is unavailable.');
    return device;
  }
  update(id: string, patch: { name?: string; enabled?: boolean; readiness?: RemoteCuaReadiness }): void {
    const state = read(this.storage); const device = state.devices.find(candidate => candidate.id === id);
    if (!device || device.revoked) throw new Error('Remote computer device was not found.');
    if (patch.name !== undefined) device.name = patch.name.trim().slice(0, 100) || device.name;
    if (patch.enabled !== undefined) device.enabled = patch.enabled;
    if (patch.readiness !== undefined) { device.readiness = patch.readiness; device.lastSeenAt = this.now(); }
    this.save(state);
  }
  revoke(id: string): void {
    const state = read(this.storage); const device = state.devices.find(candidate => candidate.id === id);
    if (!device) throw new Error('Remote computer device was not found.');
    device.revoked = true; device.enabled = false; device.readiness = undefined;
    if (state.selectedDeviceId === id) state.selectedDeviceId = undefined;
    this.save(state);
  }
}
