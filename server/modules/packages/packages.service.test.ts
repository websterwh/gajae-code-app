import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { emptyLedger, readLedger, recordInstalled, writeLedger, type CommandRunner } from '../mcp/index.js';

import { PackagesService } from './packages.service.js';

type Reply = { code: number; stdout?: string; stderr?: string };

function scripted(replies: Record<string, Reply>, calls: string[]): CommandRunner {
  return async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const reply = replies[line] ?? { code: 1, stderr: `unexpected command: ${line}` };
    return { code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'packages-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function serviceFor(root: string, runner: CommandRunner, env: NodeJS.ProcessEnv = {}): PackagesService {
  return new PackagesService({
    env: { UV_TOOLS: '', PIP_PACKAGES: '', NPM_PACKAGES: '', GITHUB_APPS: '', ...env },
    ledgerPath: join(root, 'ledger.json'),
    desiredPath: join(root, 'packages.json'),
    statePath: join(root, 'state.json'),
    runner,
  });
}

test('the list merges env seeds, stored packages and the ledger', async (t) => {
  const root = await workspace(t);
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.2.3' });
  await writeLedger(join(root, 'ledger.json'), ledger);

  const service = serviceFor(root, scripted({}, []), { UV_TOOLS: 'serena,mem0' });
  const rows = await service.list();
  assert.deepEqual(rows.map((row) => [row.name, row.source, row.status, row.version]), [
    ['mem0', 'env', 'missing', null],
    ['serena', 'env', 'installed', '1.2.3'],
  ]);
});

test('adding a package installs it and persists the desire', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  let checks = 0;
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (line === 'uv tool list') {
      checks += 1;
      return { code: 0, stdout: checks === 1 ? 'No tools installed\n' : 'serena v1.2.3\n', stderr: '' };
    }
    if (line === 'uv tool install -q serena') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
  };

  const service = serviceFor(root, runner);
  const row = await service.add({ manager: 'uv', spec: 'serena' });
  assert.equal(row.status, 'installed');
  assert.equal(row.version, '1.2.3');
  assert.equal(row.source, 'ui');
  assert.ok(calls.includes('uv tool install -q serena'));

  const stored = JSON.parse(await readFile(join(root, 'packages.json'), 'utf8')) as {
    packages: { uv: Record<string, { spec: string }> };
  };
  assert.equal(stored.packages.uv.serena.spec, 'serena');
});

test('adding a package that is already installed verifies instead of reinstalling', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const runner = scripted({ 'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' } }, calls);

  const row = await serviceFor(root, runner).add({ manager: 'uv', spec: 'serena' });
  assert.equal(row.status, 'installed');
  assert.equal(calls.some((line) => line.startsWith('uv tool install')), false);
});

test('pinning stores the version and reinstalls at it', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  let checks = 0;
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (line === 'uv tool list') {
      checks += 1;
      return { code: 0, stdout: checks === 1 ? 'serena v1.0.0\n' : 'serena v1.2.3\n', stderr: '' };
    }
    if (line === 'uv tool install -q serena==1.2.3') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
  };

  const service = serviceFor(root, runner, { UV_TOOLS: 'serena' });
  const row = await service.setPin('uv', 'serena', '1.2.3');
  assert.equal(row.pin, '1.2.3');
  assert.equal(row.version, '1.2.3');
  assert.ok(calls.includes('uv tool install -q serena==1.2.3'), 'a pin must reinstall the pinned version');

  const stored = JSON.parse(await readFile(join(root, 'packages.json'), 'utf8')) as {
    packages: { uv: Record<string, { pin: string | null }> };
  };
  assert.equal(stored.packages.uv.serena.pin, '1.2.3');
});

test('removing a package uninstalls it and forgets the desire', async (t) => {
  const root = await workspace(t);
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.2.3' });
  await writeLedger(join(root, 'ledger.json'), ledger);
  const calls: string[] = [];

  const service = serviceFor(root, scripted({
    'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' },
    'uv tool uninstall serena': { code: 0 },
  }, calls));
  await service.add({ manager: 'uv', spec: 'serena' });
  await service.remove('uv', 'serena');

  assert.equal((await service.list()).length, 0);
  assert.equal((await readLedger(join(root, 'ledger.json'))).packages.uv.serena, undefined);
  assert.ok(calls.includes('uv tool uninstall serena'), 'removing the row must uninstall the package');
});

test('a package that is already gone can still be removed from the list', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const service = serviceFor(root, scripted({
    'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' },
    'uv tool uninstall serena': { code: 1, stderr: "error: `serena` is not installed" },
  }, calls));

  await service.add({ manager: 'uv', spec: 'serena' });
  await service.remove('uv', 'serena');
  assert.equal((await service.list()).length, 0);
});

test('a failed uninstall keeps the row so it can be retried', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const service = serviceFor(root, scripted({
    'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' },
    'uv tool uninstall serena': { code: 2, stderr: 'permission denied' },
  }, calls));

  await service.add({ manager: 'uv', spec: 'serena' });
  await assert.rejects(service.remove('uv', 'serena'), /permission denied/u);
  assert.deepEqual((await service.list()).map((row) => row.name), ['serena']);
});

test('an apt package is removed with apt-get rather than uv', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const service = serviceFor(root, scripted({ 'apt-get remove -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold cowsay': { code: 0 } }, calls));

  await writeFile(join(root, 'packages.json'), JSON.stringify({
    version: 1,
    packages: { uv: {}, pip: {}, npm: {}, aqua: {}, apt: { cowsay: { manager: 'apt', spec: 'cowsay', pin: null, addedAt: '2026-01-01T00:00:00.000Z' } } },
  }), 'utf8');
  await service.remove('apt', 'cowsay');

  assert.ok(calls.includes('apt-get remove -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold cowsay'));
});

test('a pinned package refuses to upgrade', async (t) => {
  const root = await workspace(t);
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.2.3', pin: '1.2.3' });
  await writeLedger(join(root, 'ledger.json'), ledger);

  const service = serviceFor(root, scripted({}, []));
  await assert.rejects(service.upgrade('uv', 'serena'), /pinned/u);
});

test('a GitHub release package pins to a release tag', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (command === 'install-github-app') return { code: 0, stdout: '==> [GitHub App] Successfully installed jadx', stderr: '' };
    // The aqua check prints the binary and the tag the installer recorded.
    if (command === 'sh') return { code: 0, stdout: '/data/bin/jadx\n{\n  "skylot/jadx": "v1.5.0"\n}\n', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
  };
  const service = serviceFor(root, runner);

  const row = await service.add({ manager: 'aqua', spec: 'skylot/jadx', pin: 'v1.5.1' });
  assert.equal(row.pin, 'v1.5.1');
  assert.equal(row.version, 'v1.5.0', 'the release tag the installer recorded is reported as the version');
  assert.ok(calls.includes('install-github-app skylot/jadx@v1.5.1'), 'the pin is the tag the installer fetches');
});

test('a queued install waits for boot provisioning and then runs', async (t) => {
  const root = await workspace(t);
  // A live writer: the pid exists and the heartbeat is fresh.
  await writeFile(join(root, 'state.json'), JSON.stringify({
    running: true,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    completed: 0,
    failed: 0,
  }), 'utf8');

  const service = serviceFor(root, scripted({ 'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' } }, []));
  const install = service.add({ manager: 'uv', spec: 'serena' });

  // While the boot owns the queue the row waits, rather than failing or
  // claiming the package is simply not installed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pending = (await service.list()).find((row) => row.name === 'serena');
  assert.equal(pending?.waiting, true);
  assert.equal(pending?.installing, true);

  // The boot finishing is what releases the queued install.
  await writeFile(join(root, 'state.json'), JSON.stringify({ running: false, completed: 0, failed: 0 }), 'utf8');
  const row = await install;
  assert.equal(row.status, 'installed');
  assert.equal(row.waiting, undefined);
});

test('a provisioning state left by a dead writer does not block an install', async (t) => {
  const root = await workspace(t);
  // `running: true` with no pid and no heartbeat is what a container stopped
  // mid-provision leaves behind; nothing else ever cleared it.
  await writeFile(join(root, 'state.json'), JSON.stringify({ running: true, completed: 0, failed: 0 }), 'utf8');

  const service = serviceFor(root, scripted({ 'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' } }, []));
  const row = await service.add({ manager: 'uv', spec: 'serena' });
  assert.equal(row.status, 'installed');
});

test('a queued install that fails before it starts records why', async (t) => {
  const root = await workspace(t);
  const service = new PackagesService({
    env: { UV_TOOLS: '', PIP_PACKAGES: '', NPM_PACKAGES: '', GITHUB_APPS: '' },
    ledgerPath: join(root, 'ledger.json'),
    // A directory where the desire file belongs: writing the desire fails, so
    // the install never starts.
    desiredPath: root,
    statePath: join(root, 'state.json'),
    runner: scripted({}, []),
  });

  service.queue({ manager: 'apt', spec: 'scrcpy' });

  // queue() answers before the install runs and the page polls the ledger, so
  // a failure that happens before the installer does has to be written there.
  let entry = (await readLedger(join(root, 'ledger.json'))).packages.apt.scrcpy;
  for (let attempt = 0; attempt < 100 && !entry; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    entry = (await readLedger(join(root, 'ledger.json'))).packages.apt.scrcpy;
  }
  assert.equal(entry?.status, 'failed');
  assert.ok((entry?.error ?? '').length > 0, 'the failure has to carry its reason');

  const row = (await service.list()).find((item) => item.manager === 'apt' && item.name === 'scrcpy');
  assert.equal(row?.status, 'failed', 'the row reports the failure, not a bare "not installed"');
});

test('an Android SDK component refuses a pin it could not apply', async (t) => {
  const root = await workspace(t);
  const service = serviceFor(root, scripted({}, []));
  // The component name carries its own revision (`build-tools;35.0.0`), so a
  // pin would be stored but never installed - and it would stop auto-updates.
  await assert.rejects(service.setPin('android', 'platform-tools', '37.0.3'), /cannot be pinned/u);
});
