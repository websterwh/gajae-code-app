import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  emptyLedger,
  ledgerFilePath,
  readLedger,
  recordFailure,
  recordInstalled,
  writeLedger,
} from './ledger.js';
import { autoUpdatePackages, provisionPackages, type CommandRunner } from './provision.js';

type Reply = { code: number; stdout?: string; stderr?: string };

function scripted(replies: Record<string, Reply>, calls: string[]): CommandRunner {
  return async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const reply = replies[line] ?? { code: 1, stderr: `unexpected command: ${line}` };
    return { code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };
}

test('the ledger survives a round trip and a failure never erases a good install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'provision-ledger.json');
  assert.deepEqual(await readLedger(file), emptyLedger());

  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.2.3' });
  await writeLedger(file, ledger);
  assert.equal((await readLedger(file)).packages.uv.serena.version, '1.2.3');

  // A later failure records the attempt but keeps the working version.
  recordFailure(ledger, 'uv', 'serena', 'serena', 'exit 1: boom');
  assert.equal(ledger.packages.uv.serena.status, 'installed');
  assert.equal(ledger.packages.uv.serena.version, '1.2.3');
  assert.equal(ledger.packages.uv.serena.lastAttempt?.status, 'failed');

  // An unreadable ledger means "nothing installed", never "delete things".
  await writeLedger(file, emptyLedger());
  const broken = join(root, 'broken.json');
  assert.deepEqual(await readLedger(broken), emptyLedger());
});

test('a failed install is recorded as failed and retried on the next run', async () => {
  const ledger = emptyLedger();
  const calls: string[] = [];
  const runner = scripted({ 'uv tool install -q serena': { code: 2, stderr: 'boom\nmissing dependency' } }, calls);

  const first = await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner });
  assert.equal(first[0]?.status, 'failed');
  assert.match(String(first[0]?.error), /boom/u);
  assert.equal(ledger.packages.uv.serena.status, 'failed');
  assert.equal(ledger.packages.uv.serena.version, null);

  const attempts = calls.length;
  const second = await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner });
  assert.equal(second[0]?.status, 'failed');
  assert.ok(calls.length > attempts, 'a failed package must be retried, not skipped as installed');
});

test('a successful install and verification records the concrete version', async () => {
  const ledger = emptyLedger();
  const runner = scripted({
    'uv tool install -q serena': { code: 0 },
    'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' },
  }, []);

  const outcomes = await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner });
  assert.equal(outcomes[0]?.status, 'installed');
  assert.equal(outcomes[0]?.version, '1.2.3');
  assert.equal(ledger.packages.uv.serena.status, 'installed');
  assert.equal(ledger.packages.uv.serena.version, '1.2.3');
});

test('a pin is applied in the manager syntax', async () => {
  const ledger = emptyLedger();
  const calls: string[] = [];
  let verifications = 0;
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (line === 'uv tool list') {
      verifications += 1;
      return { code: 0, stdout: verifications === 1 ? 'serena v1.0.0\n' : 'serena v1.2.3\n', stderr: '' };
    }
    if (line === 'uv tool install -q serena==1.2.3') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
  };

  await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner, pins: { serena: '1.2.3' } });
  assert.ok(calls.includes('uv tool install -q serena==1.2.3'));
  assert.equal(ledger.packages.uv.serena.pin, '1.2.3');
});

test('verify-first leaves a healthy install alone instead of reinstalling it', async () => {
  const ledger = emptyLedger();
  const calls: string[] = [];
  const runner = scripted({ 'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' } }, calls);

  const outcomes = await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner });
  assert.equal(outcomes[0]?.status, 'installed');
  assert.equal(outcomes[0]?.action, 'verified');
  assert.equal(calls.some((line) => line.startsWith('uv tool install')), false, 'a verified package must not be reinstalled');
  assert.equal(ledger.packages.uv.serena.version, '1.2.3');
});

test('an install that exits 0 but leaves the package absent is a failure', async () => {
  const ledger = emptyLedger();
  const runner = scripted({
    'uv tool install -q serena': { code: 0 },
    // `uv tool list` exits 0 on an empty tool set; exit status alone is not proof.
    'uv tool list': { code: 0, stdout: 'No tools installed\n' },
  }, []);

  const outcomes = await provisionPackages({ manager: 'uv', packages: ['serena'], ledger, runner });
  assert.equal(outcomes[0]?.status, 'failed');
  assert.equal(ledger.packages.uv.serena.status, 'failed');
});

test('auto-update moves unpinned packages and leaves pinned ones alone', async () => {
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'pinned-one', { spec: 'pinned-one', version: '1.0.0', pin: '1.0.0' });
  recordInstalled(ledger, 'uv', 'free-one', { spec: 'free-one', version: '1.0.0' });
  const calls: string[] = [];
  const lines: string[] = [];
  const runner = scripted({
    'uv tool upgrade -q free-one': { code: 0 },
    'uv tool list': { code: 0, stdout: 'free-one v2.0.0\n' },
  }, calls);

  const outcomes = await autoUpdatePackages({ manager: 'uv', ledger, runner, log: (line) => lines.push(line) });
  assert.equal(outcomes.length, 1);
  assert.equal(calls.some((line) => line.includes('pinned-one')), false);
  assert.equal(ledger.packages.uv['free-one'].version, '2.0.0');
  assert.ok(lines.some((line) => /pinned to 1\.0\.0/u.test(line)));
  assert.ok(lines.some((line) => /1\.0\.0 -> 2\.0\.0/u.test(line)));
});

test('a uv tool missing from the inventory is reinstalled instead of failing forever', async () => {
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.0.0' });
  const calls: string[] = [];
  const runner = scripted({
    'uv tool upgrade -q serena': {
      code: 1,
      stderr: 'error: Failed to upgrade serena | cause: `serena` is not installed; run `uv tool install serena` to install',
    },
    'uv tool install -q serena': { code: 0 },
    'uv tool list': { code: 0, stdout: 'serena v2.0.0\n' },
  }, calls);

  const outcomes = await autoUpdatePackages({ manager: 'uv', ledger, runner });
  assert.equal(outcomes[0]?.status, 'installed');
  assert.ok(calls.includes('uv tool install -q serena'), 'a missing tool must be installed, not just upgraded');
  assert.equal(ledger.packages.uv.serena.version, '2.0.0');
  assert.equal(ledger.packages.uv.serena.lastAttempt, undefined);
});

test('a git-installed uv tool is upgraded under the name uv registered', async () => {
  const ledger = emptyLedger();
  const spec = 'git+https://github.com/oraios/serena';
  recordInstalled(ledger, 'uv', 'serena', { spec, version: '0.1.4' });
  const calls: string[] = [];
  // uv registers the distribution by its project name and lists the commands
  // it exposes underneath, which is where the spec name shows up.
  const runner = scripted({
    'uv tool list': { code: 0, stdout: 'serena-agent v0.1.4\n- serena\n- serena-agent\n' },
    'uv tool upgrade -q serena-agent': { code: 0 },
  }, calls);

  const outcomes = await autoUpdatePackages({ manager: 'uv', ledger, runner });
  assert.equal(outcomes[0]?.status, 'installed');
  assert.ok(calls.includes('uv tool upgrade -q serena-agent'), 'the registered name is what uv upgrades');
  assert.equal(calls.includes('uv tool upgrade -q serena'), false);
  assert.equal(calls.some((line) => line.startsWith('uv tool install')), false, 'an installed tool must not be reinstalled');
  assert.equal(ledger.packages.uv.serena.status, 'installed');
});

test('aqua verification checks the installed binary, not a config-less aqua list', async () => {
  const ledger = emptyLedger();
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'install-github-app') return { code: 0, stdout: '', stderr: '' };
    if (command === 'sh') {
      assert.equal(args[0], '-c');
      assert.deepEqual(args.slice(2), ['sh', 'jadx', 'skylot/jadx']);
      return { code: 0, stdout: '/data/bin/jadx\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected command: ${command}` };
  };

  const outcomes = await provisionPackages({ manager: 'aqua', packages: ['skylot/jadx'], ledger, runner });
  assert.equal(outcomes[0]?.status, 'installed');
  assert.equal(ledger.packages.aqua['skylot/jadx'].status, 'installed');
  assert.ok(calls.some((line) => line.startsWith('sh -c')));
});

test('the ledger lives under the config mount, not the data volume', () => {
  assert.equal(
    ledgerFilePath({ GJC_WORKER_AGENT_DIR: '/root/.gjc/agent' }),
    '/root/.gjc/app/provision-ledger.json',
  );
  assert.equal(ledgerFilePath({ GJC_PROVISION_LEDGER: '/tmp/custom.json' }), '/tmp/custom.json');
});
