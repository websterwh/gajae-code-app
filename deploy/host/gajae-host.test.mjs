import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAgentsMd } from './agents-md.mjs';
import { collectFacts, parseBlockDevices, parseOsRelease } from './facts.mjs';
import { describeVerbs, executeVerb } from './verbs.mjs';

const fakeHost = async (command) => {
  if (command.includes('command -v systemctl rc-service')) return { code: 0, stdout: '/usr/sbin/service', stderr: '' };
  if (command.includes('command -v systemctl')) return { code: 1, stdout: '', stderr: '' };
  if (command.includes('command -v apt-get')) return { code: 0, stdout: '/usr/bin/apt-get', stderr: '' };
  if (command.includes('command -v ss')) return { code: 0, stdout: '/usr/bin/ss', stderr: '' };
  if (command.includes('command -v zpool')) return { code: 0, stdout: '/sbin/zpool', stderr: '' };
  if (command.includes('readlink -f /sbin/init')) return { code: 0, stdout: '/sbin/init', stderr: '' };
  if (command.includes('service --status-all')) return { code: 0, stdout: ' [ + ] cron\n [ + ] docker', stderr: '' };
  if (command.includes('zpool list')) return { code: 0, stdout: 'tank 3.6T 1.2T 2.4T ONLINE', stderr: '' };
  if (command.includes('docker version')) return { code: 0, stdout: '29.9.3', stderr: '' };
  if (command.includes('docker info')) return { code: 0, stdout: '/mnt/cache/appdata/docker', stderr: '' };
  if (command.includes('docker ps')) {
    return {
      code: 0,
      stdout: 'godoxy|ghcr.example/godoxy|Up 2 days|0.0.0.0:443->443/tcp\ngajae-app|ghcr.example/gajae|Up 3 hours|0.0.0.0:3005->3001/tcp',
      stderr: '',
    };
  }
  if (command.includes('lsblk')) {
    return {
      code: 0,
      stdout: 'NAME="sda" SIZE="500107862016" TYPE="disk" FSTYPE="" MOUNTPOINT="" RO="0" MODEL="Samsung SSD"\n'
        + 'NAME="sda1" SIZE="500105859072" TYPE="part" FSTYPE="squashfs" MOUNTPOINT="/" RO="1" MODEL=""',
      stderr: '',
    };
  }
  if (command.includes('df -hP')) {
    return { code: 0, stdout: 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 40G 55G 43% /', stderr: '' };
  }
  if (command.includes('ip -o -4 addr')) return { code: 0, stdout: 'eth0 192.0.2.10/24', stderr: '' };
  if (command.includes('ip -o -4 route')) return { code: 0, stdout: 'default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.10', stderr: '' };
  if (command.includes('ss -lntuH')) return { code: 0, stdout: 'tcp 0.0.0.0:3005', stderr: '' };
  if (command.includes('find /etc/cron.d')) return { code: 0, stdout: '/etc/cron.daily/apt-compat', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

const fakeFiles = {
  '/etc/os-release': 'ID=devuan\nPRETTY_NAME="Devuan GNU/Linux 6"\nVERSION_ID=6\n',
  '/proc/1/comm': 'init\n',
  '/etc/resolv.conf': 'nameserver 192.0.2.1\n',
  '/proc/mounts': '/dev/root / squashfs ro,relatime 0 0\n/dev/sda2 /boot vfat rw,relatime 0 0\nproc /proc proc rw 0 0\n',
  '/proc/meminfo': 'MemTotal: 131072000 kB\nMemAvailable: 98304000 kB\nSwapTotal: 4194304 kB\nSwapFree: 4194304 kB\n',
  '/proc/loadavg': '0.42 0.31 0.25 2/512 4242\n',
  '/proc/uptime': '345600.00 1200.00\n',
  '/proc/swaps': 'Filename Type Size Used Priority\n/dev/zram0 partition 4194304 0 5\n',
  '/proc/mdstat': 'Personalities : [raid1]\nmd0 : active raid1 sdb1[0] sdc1[1]\n      1953382464 blocks super 1.2 [2/2] [UU]\n',
  '/proc/partitions': 'major minor  #blocks  name\n\n   8        0  488386584 sda\n   8        1  488384000 sda1\n',
  '/sys/fs/cgroup/cgroup.controllers': 'cpu memory\n',
  '/sys/kernel/security/lsm': 'capability,apparmor\n',
  '/etc/crontab': '# comment\n0 3 * * * root /usr/local/bin/backup\n',
};

const readFake = async (file) => {
  if (file in fakeFiles) return fakeFiles[file];
  throw new Error('ENOENT');
};

const factsFor = (overrides = {}) => collectFacts({
  run: fakeHost,
  read: readFake,
  now: () => new Date('2026-11-10T12:00:00.000Z'),
  hostnameOf: () => 'Webby',
  ...overrides,
});

test('os-release parsing keeps the friendly name and drops quoting', () => {
  assert.deepEqual(parseOsRelease('ID=devuan\nPRETTY_NAME="Devuan GNU/Linux 6"\nVERSION_ID=6\n'), {
    id: 'devuan',
    name: null,
    prettyName: 'Devuan GNU/Linux 6',
    version: '6',
  });
});

test('lsblk pairs survive a model name with spaces', () => {
  const [disk] = parseBlockDevices('NAME="sda" SIZE="500107862016" TYPE="disk" FSTYPE="" MOUNTPOINT="" RO="0" MODEL="Samsung SSD 870"');
  assert.deepEqual(disk, {
    name: 'sda', size: 500107862016, type: 'disk', filesystem: null, mount: null, readOnly: false, model: 'Samsung SSD 870',
  });
});

test('facts describe an image-backed non-systemd host with a proxy and the app container', async () => {
  const facts = await factsFor();
  assert.equal(facts.init.systemd, false);
  assert.equal(facts.init.name, 'init');
  assert.equal(facts.services.manager, 'service');
  assert.deepEqual(facts.services.running, ['[ + ] cron', '[ + ] docker']);
  assert.equal(facts.packages.manager, 'apt-get');
  assert.equal(facts.containers.list.length, 2);
  assert.equal(facts.containers.rootDir, '/mnt/cache/appdata/docker');
  assert.equal(facts.resources.disks[0].mount, '/');
  assert.equal(facts.resources.memory.usedPercent, 25);
  assert.equal(facts.resources.loadAverage.one, 0.42);
  assert.equal(facts.resources.uptimeSeconds, 345600);
  assert.equal(facts.resources.swap.totalMB, 4096);
  assert.equal(facts.storage.root.filesystem, 'squashfs');
  assert.equal(facts.storage.rootImageBacked, true);
  assert.equal(facts.storage.writable[0].mount, '/boot');
  assert.equal(facts.storage.blockDevices.length, 2);
  assert.equal(facts.storage.pools[0].health, 'ONLINE');
  assert.match(facts.storage.raid[0], /^md0/u);
  assert.equal(facts.network.addresses[0].address, '192.0.2.10/24');
  assert.equal(facts.network.gateway, '192.0.2.1');
  assert.equal(facts.network.listeners[0].address, '0.0.0.0:3005');
  assert.deepEqual(facts.network.nameservers, ['192.0.2.1']);
  assert.equal(facts.scheduled.cron.length, 1);
  assert.deepEqual(facts.scheduled.cronFiles, ['/etc/cron.daily/apt-compat']);
  assert.equal(facts.security.cgroupV2, true);
  const quirks = facts.quirks.join('\n');
  assert.match(quirks, /not systemd/u);
  assert.match(quirks, /image unpacked at boot/u);
  assert.match(quirks, /\/boot/u);
  assert.match(quirks, /zram/u);
  assert.match(quirks, /Software RAID/u);
  assert.match(quirks, /ZFS pools present: tank \(ONLINE\)/u);
  assert.match(quirks, /godoxy/u);
  assert.match(quirks, /gajae-app/u);
  assert.match(quirks, /cgroup v2/u);
});

test('a host without lsblk still lists disks from /proc/partitions', async () => {
  const facts = await factsFor({
    run: async (command) => (command.includes('lsblk')
      ? { code: 127, stdout: '', stderr: 'lsblk: not found' }
      : fakeHost(command)),
  });
  assert.deepEqual(facts.storage.blockDevices.map((device) => device.name), ['sda', 'sda1']);
  assert.equal(facts.storage.blockDevices[1].size, 500105216000);
  assert.match(facts.quirks.join('\n'), /`lsblk` is not installed/u);
});

test('a RAM-backed rootfs is treated as ephemeral and Docker mounts are not storage', async () => {
  const facts = await factsFor({
    read: async (file) => (file === '/proc/mounts'
      ? 'rootfs / rootfs rw 0 0\n/dev/sda2 /boot vfat rw 0 0\noverlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n'
      : readFake(file)),
  });
  assert.equal(facts.storage.rootImageBacked, true);
  assert.deepEqual(facts.storage.writable.map((entry) => entry.mount), ['/boot']);
  assert.match(facts.quirks.join('\n'), /lost on reboot/u);
});

test('a disk-backed root is never called ephemeral', async () => {
  const facts = await factsFor({
    read: async (file) => (file === '/proc/mounts'
      ? '/dev/sda1 / ext4 rw,relatime 0 0\n/dev/sda2 /boot ext4 rw,relatime 0 0\n'
      : readFake(file)),
  });
  assert.equal(facts.storage.rootImageBacked, false);
  assert.equal(facts.quirks.some((quirk) => /image unpacked at boot/u.test(quirk)), false);
});

test('a bare host still produces facts instead of failing', async () => {
  const facts = await collectFacts({
    run: async () => ({ code: 127, stdout: '', stderr: 'not found' }),
    read: async () => { throw new Error('ENOENT'); },
    hostnameOf: () => 'bare',
  });
  assert.equal(facts.containers.runtime, null);
  assert.equal(facts.packages.manager, null);
  assert.equal(facts.services.manager, null);
  assert.equal(facts.system.hostname, 'bare');
  assert.equal(facts.storage.rootImageBacked, false);
  assert.ok(facts.quirks.some((quirk) => /df returned nothing/u.test(quirk)));
  const markdown = renderAgentsMd(facts);
  assert.match(markdown, /No temperature sensors or UPS were readable/u);
  assert.doesNotMatch(markdown, /undefined/u);
});

test('the generated AGENTS.md carries the observations and the rules', async () => {
  const markdown = renderAgentsMd(await factsFor(), { root: '/srv/gajae/' });
  assert.match(markdown, /^# AGENTS\.md — Webby$/mu);
  assert.match(markdown, /Devuan GNU\/Linux 6/u);
  assert.match(markdown, /Where state survives/u);
  assert.match(markdown, /squashfs/u);
  assert.match(markdown, /ZFS pools:/u);
  assert.match(markdown, /Default gateway: 192\.0\.2\.1/u);
  assert.match(markdown, /godoxy/u);
  assert.match(markdown, /Mutating verbs/u);
  assert.match(markdown, /\/srv\/gajae\/deploy\/host\/gajae-host\.mjs run host\.info/u);
  assert.doesNotMatch(markdown, /undefined/u);
});

test('mutating verbs are declared but not executable', () => {
  const verbs = describeVerbs();
  assert.equal(verbs.find((verb) => verb.id === 'host.info').enabled, true);
  const restart = verbs.find((verb) => verb.id === 'docker.restart');
  assert.equal(restart.mutating, true);
  assert.equal(restart.enabled, false);
});

test('an unknown verb is refused by name', async () => {
  await assert.rejects(
    () => executeVerb('host.shell', { run: async () => ({ code: 0, stdout: '', stderr: '' }) }),
    /UNKNOWN_VERB/u,
  );
});

test('a target must be a plain name, never a command fragment', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(() => executeVerb('docker.inspect', { run }), /TARGET_REQUIRED/u);
  await assert.rejects(
    () => executeVerb('docker.inspect', { target: 'app; rm -rf /', run }),
    /INVALID_TARGET/u,
  );
  await assert.rejects(
    () => executeVerb('service.status', { target: '$(reboot)', run }),
    /INVALID_TARGET/u,
  );
});

test('a mutation refuses to run, with or without the opt-in', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(() => executeVerb('docker.restart', { target: 'gajae-app', run }), /VERB_NOT_ALLOWED/u);
  await assert.rejects(
    () => executeVerb('docker.restart', { target: 'gajae-app', allowMutating: true, run }),
    /VERB_NOT_ENABLED/u,
  );
});

test('a read-only verb runs exactly one fixed command', async () => {
  const seen = [];
  const result = await executeVerb('service.status', {
    target: 'mos',
    run: async (command) => {
      seen.push(command);
      return { code: 0, stdout: 'active', stderr: '' };
    },
  });
  assert.deepEqual(seen, ['service mos status']);
  assert.equal(result.stdout, 'active');
  assert.equal(result.mutating, false);
});
