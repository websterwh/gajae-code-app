import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostContainer, HostInfo } from './gjc-docker-socket.js';
import { detectHost } from './gjc-host-discovery.js';

const info = (overrides: Partial<HostInfo> = {}): HostInfo => ({
  serverVersion: '28.0.0',
  operatingSystem: 'Debian GNU/Linux 12 (bookworm)',
  kernelVersion: '6.1.0-18-amd64',
  hostName: 'webby',
  driver: 'overlay2',
  swarm: 'inactive',
  ncpu: 4,
  memTotal: 1024,
  containers: 0,
  containersRunning: 0,
  containersStopped: 0,
  images: 0,
  ...overrides,
});

const container = (name: string, image: string): HostContainer => ({
  id: name.padEnd(12, '0'),
  name,
  image,
  state: 'running',
  status: 'Up 2 hours',
  labels: {},
  mounts: [],
});

const detect = (overrides: Partial<HostInfo> = {}, containers: HostContainer[] = []) =>
  detectHost({ info: info(overrides), containers, socketPath: '/var/run/docker.sock' });

const ids = (result: ReturnType<typeof detect>) => result.platforms.map((platform) => platform.id);

test('the platform table names the appliance behind an otherwise plain Debian', () => {
  // These four report a Debian or Slackware userland; only the kernel, the
  // hostname or the product string distinguishes them.
  assert.deepEqual(ids(detect({ operatingSystem: 'Slackware 15.0 x86_64', kernelVersion: '6.12.10-Unraid' })), ['unraid']);
  assert.deepEqual(ids(detect({ operatingSystem: 'Devuan GNU/Linux 6 (excalibur)', kernelVersion: '6.12.10-mos' })), ['mos']);
  assert.deepEqual(ids(detect({ kernelVersion: '6.8.12-4-pve' })), ['proxmox']);
  assert.deepEqual(ids(detect({ hostName: 'openmediavault' })), ['openmediavault']);
  assert.deepEqual(ids(detect({ operatingSystem: 'ZimaOS 1.3' })), ['zimaos']);
});

test('an appliance that ships containers is named by them when the kernel is anonymous', () => {
  const casa = detect({}, [container('casaos', 'icewhale/casaos:0.4'), container('casaos-gateway', 'icewhale/casaos-gateway:0.4')]);
  assert.deepEqual(ids(casa), ['casaos']);
  // Two containers, two signals: evidence is one line per container that matched.
  assert.equal(casa.platforms[0]?.evidence.length, 2);

  assert.deepEqual(ids(detect({}, [container('openmediavault', 'openmediavault/openmediavault:7')])), ['openmediavault']);
});

test('a hypervisor guest says so in the guidance, and a plain host claims nothing', () => {
  const proxmox = detect({ kernelVersion: '6.8.12-4-pve' });
  assert.equal(proxmox.platforms[0]?.kind, 'hypervisor');
  assert.ok(proxmox.guidance.some((line) => line.includes('Proxmox VE provides this kernel')));

  const plain = detect();
  assert.deepEqual(plain.platforms, []);
  assert.deepEqual(plain.managers, []);
  assert.ok(plain.guidance.some((line) => line.includes('No known container manager detected')));
});

test('lookalike names do not become platforms', () => {
  // A mosquitto broker is not MOS, and running Portainer does not make the
  // machine an appliance.
  const lookalike = detect({}, [container('mosquitto', 'eclipse-mosquitto:2'), container('portainer', 'portainer/portainer-ce:2')]);
  assert.deepEqual(ids(lookalike), []);
  assert.deepEqual(lookalike.managers.map((manager) => manager.id), ['portainer']);
});
