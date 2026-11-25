import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSshVerb,
  hostFileReadCommand,
  knownHostsLine,
  resolveHostFilePath,
  resolveSshCommand,
  sshArguments,
  SSH_WRITE_VERBS,
} from './gjc-ssh-host.js';

const target = {
  host: '10.0.0.5',
  port: 22,
  user: 'root',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
};

test('the pinned key is the only trusted key, and a non-default port is part of its name', () => {
  assert.equal(knownHostsLine(target), `${target.hostKey}\n`.replace(target.hostKey, `${target.host} ${target.hostKey}`));
  assert.equal(knownHostsLine({ ...target, port: 2222 }), `[${target.host}]:2222 ${target.hostKey}\n`);
});

test('ssh ignores a user config, a second identity and any prompt', () => {
  const args = sshArguments(target, 'df -hP', { key: '/run/key', knownHosts: '/run/known_hosts' });

  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null']);
  for (const option of [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile=/run/known_hosts',
    'GlobalKnownHostsFile=/dev/null',
    'IdentitiesOnly=yes',
    'ConnectTimeout=10',
  ]) {
    assert.ok(args.includes(option), option);
  }
  assert.equal(args[args.indexOf('-i') + 1], '/run/key');
  assert.equal(args[args.indexOf('-p') + 1], '22');
  assert.equal(args[args.indexOf('-l') + 1], 'root');
  assert.equal(args.at(-2), target.host);
  assert.equal(args.at(-1), "sh -c 'df -hP'");
});

test('container read verbs answer logs, configuration and resource use without a shell', () => {
  const logs = findSshVerb('docker.logs');
  assert.ok(logs);
  assert.equal(logs.mutating, false);
  assert.equal(resolveSshCommand(logs, 'qui'), 'docker logs --tail 300 qui');
  assert.throws(() => resolveSshCommand(logs, 'qui; rm -rf /'), /INVALID_TARGET/u);
  assert.throws(() => resolveSshCommand(logs), /TARGET_REQUIRED/u);

  const config = findSshVerb('docker.config');
  assert.ok(config);
  assert.equal(config.mutating, false);
  const command = resolveSshCommand(config, 'qui');
  assert.match(command, /\.Config\.Image/u);
  assert.match(command, /\.Mounts/u);
  // A container's environment is where its secrets live.
  assert.doesNotMatch(command, /\.Config\.Env/u);
  assert.throws(() => resolveSshCommand(config, 'qui; rm -rf /'), /INVALID_TARGET/u);

  const stats = findSshVerb('docker.stats');
  assert.ok(stats);
  assert.equal(stats.mutating, false);
  assert.match(resolveSshCommand(stats), /docker stats --no-stream/u);
});

test('a host path read is one listing or one bounded read, quoted for the remote shell', () => {
  assert.equal(resolveHostFilePath('/mnt/cache/appdata/qui/config'), '/mnt/cache/appdata/qui/config');
  for (const path of ['', 'relative/path', '/etc/../etc/shadow', '/etc/passwd\nrm -rf /', '/etc/pass\u0000wd']) {
    assert.throws(() => resolveHostFilePath(path), /path must/u, JSON.stringify(path));
  }
  assert.throws(() => resolveHostFilePath(42), /path must be a string/u);

  const command = hostFileReadCommand("/srv/my app's config");
  assert.equal(command, "if [ -d '/srv/my app'\\''s config' ]; then ls -la -- '/srv/my app'\\''s config'; else head -c 262144 -- '/srv/my app'\\''s config'; fi");
  assert.match(hostFileReadCommand('/etc/hostname'), /head -c 262144 -- '\/etc\/hostname'/u);
});

test('writes are verbs with a validated target, never a command', () => {
  assert.deepEqual(SSH_WRITE_VERBS.map((verb) => verb.id), ['service.restart', 'docker.restart']);

  const restart = findSshVerb('docker.restart');
  assert.ok(restart);
  assert.equal(resolveSshCommand(restart, 'godoxy'), 'docker restart godoxy');
  assert.throws(() => resolveSshCommand(restart, 'godoxy; rm -rf /'), /INVALID_TARGET/u);
  assert.throws(() => resolveSshCommand(restart), /TARGET_REQUIRED/u);

  const read = findSshVerb('host.disk');
  assert.ok(read);
  assert.throws(() => resolveSshCommand(read, 'anything'), /takes no target/u);
});
