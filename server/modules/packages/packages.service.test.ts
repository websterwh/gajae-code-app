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

test('removing a package stops managing it and uninstalls nothing', async (t) => {
  const root = await workspace(t);
  const ledger = emptyLedger();
  recordInstalled(ledger, 'uv', 'serena', { spec: 'serena', version: '1.2.3' });
  await writeLedger(join(root, 'ledger.json'), ledger);
  const calls: string[] = [];

  const service = serviceFor(root, scripted({ 'uv tool list': { code: 0, stdout: 'serena v1.2.3\n' } }, calls));
  await service.add({ manager: 'uv', spec: 'serena' });
  await service.remove('uv', 'serena');

  assert.equal((await service.list()).length, 0);
  assert.equal((await readLedger(join(root, 'ledger.json'))).packages.uv.serena, undefined);
  assert.equal(calls.some((line) => /uninstall/u.test(line)), false);
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

test('a boot provision in flight blocks a second install', async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, 'state.json'), JSON.stringify({ running: true, completed: 0, failed: 0 }), 'utf8');

  const service = serviceFor(root, scripted({}, []));
  await assert.rejects(service.add({ manager: 'uv', spec: 'serena' }), /already running/u);
});
