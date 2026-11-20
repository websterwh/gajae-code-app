import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSshVerb,
  knownHostsLine,
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
