import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAgentsMd } from './agents-md.mjs';
import { collectFacts, parseOsRelease } from './facts.mjs';
import { describeVerbs, executeVerb } from './verbs.mjs';

const fakeHost = async (command) => {
  if (command.includes('command -v systemctl')) return { code: 1, stdout: '', stderr: '' };
  if (command.includes('command -v apt-get')) return { code: 0, stdout: '/usr/bin/apt-get', stderr: '' };
  if (command.includes('command -v ss')) return { code: 0, stdout: '/usr/bin/ss', stderr: '' };
  if (command.includes('readlink -f /sbin/init')) return { code: 0, stdout: '/sbin/init', stderr: '' };
  if (command.includes('docker version')) return { code: 0, stdout: '29.9.3', stderr: '' };
  if (command.includes('docker ps')) {
    return {
      code: 0,
      stdout: 'godoxy|ghcr.example/godoxy|Up 2 days|0.0.0.0:443->443/tcp\ngajae-app|ghcr.example/gajae|Up 3 hours|0.0.0.0:3005->3001/tcp',
      stderr: '',
    };
  }
  if (command.includes('df -hP')) {
    return { code: 0, stdout: 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 40G 55G 43% /', stderr: '' };
  }
  if (command.includes('ip -o -4')) return { code: 0, stdout: 'eth0 192.0.2.10/24', stderr: '' };
  if (command.includes('ss -lntuH')) return { code: 0, stdout: 'tcp 0.0.0.0:3005', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

const fakeFiles = {
  '/etc/os-release': 'ID=devuan\nPRETTY_NAME="Devuan GNU/Linux 6"\nVERSION_ID=6\n',
  '/proc/1/comm': 'init\n',
  '/etc/resolv.conf': 'nameserver 192.0.2.1\n',
  '/sys/fs/cgroup/cgroup.controllers': 'cpu memory\n',
  '/sys/kernel/security/lsm': 'capability,apparmor\n',
  '/etc/crontab': '# comment\n0 3 * * * root /usr/local/bin/backup\n',
};

const factsFor = () => collectFacts({
  run: fakeHost,
  read: async (file) => {
    if (file in fakeFiles) return fakeFiles[file];
    throw new Error('ENOENT');
  },
  now: () => new Date('2026-11-10T12:00:00.000Z'),
  hostnameOf: () => 'Webby',
});

test('os-release parsing keeps the friendly name and drops quoting', () => {
  assert.deepEqual(parseOsRelease('ID=devuan\nPRETTY_NAME="Devuan GNU/Linux 6"\nVERSION_ID=6\n'), {
    id: 'devuan',
    name: null,
    prettyName: 'Devuan GNU/Linux 6',
    version: '6',
  });
});

test('facts describe a non-systemd host with a proxy and the app container', async () => {
  const facts = await factsFor();
  assert.equal(facts.init.systemd, false);
  assert.equal(facts.init.name, 'init');
  assert.equal(facts.packages.manager, 'apt-get');
  assert.equal(facts.containers.list.length, 2);
  assert.equal(facts.resources.disks[0].mount, '/');
  assert.equal(facts.network.addresses[0].address, '192.0.2.10/24');
  assert.equal(facts.network.listeners[0].address, '0.0.0.0:3005');
  assert.deepEqual(facts.network.nameservers, ['192.0.2.1']);
  assert.equal(facts.scheduled.cron.length, 1);
  assert.equal(facts.security.cgroupV2, true);
  assert.match(facts.quirks.join('\n'), /not systemd/u);
  assert.match(facts.quirks.join('\n'), /godoxy/u);
  assert.match(facts.quirks.join('\n'), /gajae-app/u);
  assert.match(facts.quirks.join('\n'), /cgroup v2/u);
});

test('a bare host still produces facts instead of failing', async () => {
  const facts = await collectFacts({
    run: async () => ({ code: 127, stdout: '', stderr: 'not found' }),
    read: async () => { throw new Error('ENOENT'); },
    hostnameOf: () => 'bare',
  });
  assert.equal(facts.containers.runtime, null);
  assert.equal(facts.packages.manager, null);
  assert.equal(facts.system.hostname, 'bare');
  assert.ok(facts.quirks.some((quirk) => /df returned nothing/u.test(quirk)));
});

test('the generated AGENTS.md carries the observations and the rules', async () => {
  const markdown = renderAgentsMd(await factsFor(), { root: '/srv/gajae/' });
  assert.match(markdown, /^# AGENTS\.md — Webby$/mu);
  assert.match(markdown, /Devuan GNU\/Linux 6/u);
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
