import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { McpService } from './mcp.service.js';
import { REDACTED } from './mcp.config.js';

type StoredFile = { mcpServers: Record<string, Record<string, unknown>>; disabledServers?: string[] };

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

function all(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] as string;
    if (current === name && args[index + 1] !== undefined) values.push(args[index + 1] as string);
    else if (current.startsWith(`${name}=`)) values.push(current.slice(name.length + 1));
  }
  return values;
}

/** A stand-in for `gjc mcp add/remove` that writes the real file. */
function fakeCli(agentDir: string, calls: string[][]) {
  const configFile = join(agentDir, 'mcp.json');
  const read = async (): Promise<StoredFile> => {
    try { return JSON.parse(await readFile(configFile, 'utf8')) as StoredFile; }
    catch { return { mcpServers: {} }; }
  };
  return async (args: string[]) => {
    calls.push(args);
    const data = await read();
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = args[2] as string;
      const entry: Record<string, unknown> = { type: flag(args, '--type') };
      const command = flag(args, '--command');
      if (command) entry.command = command;
      const argValues = all(args, '--arg');
      if (argValues.length) entry.args = argValues;
      const envValues = all(args, '--env');
      if (envValues.length) {
        entry.env = Object.fromEntries(envValues.map((value) => {
          const at = value.indexOf('=');
          return [value.slice(0, at), value.slice(at + 1)];
        }));
      }
      const url = flag(args, '--url');
      if (url) entry.url = url;
      const headers = all(args, '--header');
      if (headers.length) {
        entry.headers = Object.fromEntries(headers.map((value) => {
          const at = value.indexOf('=');
          return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
        }));
      }
      data.mcpServers[name] = entry;
      await writeFile(configFile, `${JSON.stringify(data, null, 2)}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'remove') {
      delete data.mcpServers[args[2] as string];
      await writeFile(configFile, `${JSON.stringify(data, null, 2)}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };
}

const PROBE = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'probe_echo' }] } });
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } });
});
`;

test('add → list → toggle → pin → verify → remove against a temporary mcp.json', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, calls), verifyTimeoutMs: 3_000 });

  const added = await service.add({
    name: 'custom', transport: 'stdio', command: 'npx', args: ['-y', 'custom-mcp'], env: { API_TOKEN: 'super-secret' },
  });
  // The configure form edits the stored entry, so its values come back as they are.
  assert.equal(added.env.API_TOKEN, 'super-secret');
  assert.equal(added.envIsSet.API_TOKEN, true);
  // Spawning is argv-only: the secret is one argument, never a shell string.
  assert.deepEqual(calls[0]?.slice(0, 2), ['mcp', 'add']);
  assert.ok(calls[0]?.includes('--env=API_TOKEN=super-secret'));
  // Every value flag carries its value inline. Space-separated, gjc reads the
  // `-y` of `npx -y <pkg>` as a flag and exits 2 with nothing written.
  const valueFlags = (calls[0] ?? []).filter((arg) => arg.startsWith('--') && arg !== '--project');
  assert.ok(valueFlags.length > 0);
  assert.ok(valueFlags.every((arg) => arg.includes('=')), `inline values only: ${valueFlags.join(' ')}`);
  assert.ok(calls[0]?.includes('--type=stdio'));
  assert.ok(calls[0]?.includes('--arg=-y'));

  const listed = await service.list('global');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, 'custom');

  const toggled = await service.update('global', 'custom', { enabled: false });
  assert.equal(toggled.enabled, false);
  const toggledDisk = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  // The runtime honors `enabled`; the old `disabled` field was ignored.
  assert.equal(toggledDisk.mcpServers.custom?.enabled, false);
  assert.equal('disabled' in (toggledDisk.mcpServers.custom ?? {}), false);

  // A rotation sends only the new value; the redaction marker keeps the old one.
  await service.update('global', 'custom', { env: { API_TOKEN: REDACTED, EXTRA: 'two' } });
  const onDisk = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(onDisk.mcpServers.custom?.env && (onDisk.mcpServers.custom.env as Record<string, string>).API_TOKEN, 'super-secret');
  assert.equal((onDisk.mcpServers.custom?.env as Record<string, string>).EXTRA, 'two');

  const pinned = await service.pin('global', 'custom', '1.2.3');
  assert.equal(pinned.pin, '1.2.3');

  // Atomic writes leave no temp files behind.
  assert.equal((await readdir(root)).some((name) => name.includes('.tmp')), false);

  // Verify spawns a real stdio server; it reports the tool count, not a guess.
  const script = join(root, 'probe.mjs');
  await writeFile(script, PROBE);
  await service.update('global', 'custom', { command: process.execPath, args: [script] });
  const verified = await service.verify('global', 'custom');
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.toolCount, 1);
  assert.deepEqual(verified.tools, ['probe_echo']);

  await service.remove('global', 'custom');
  assert.deepEqual(await service.list('global'), []);
});

test('a stored legacy disabled flag is migrated to the switch the runtime reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: { off: { type: 'stdio', command: 'npx', args: ['-y', 'off'], disabled: true } },
  }));
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []), verifyTimeoutMs: 3_000 });
  const [server] = await service.list('global');
  assert.equal(server?.enabled, false);
  const disk = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(disk.mcpServers.off?.enabled, false);
  assert.equal('disabled' in (disk.mcpServers.off ?? {}), false);
});

test('the runtime\'s own keys and denylist survive a toggle or an edit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: {
      kept: { type: 'stdio', command: 'npx', args: ['-y', 'kept'], timeout: 10_000, autoload: false, enabled: false },
      denied: { type: 'stdio', command: 'npx', args: ['-y', 'denied'] },
    },
    disabledServers: ['denied'],
  }));
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []), verifyTimeoutMs: 3_000 });

  const kept = await service.update('global', 'kept', { args: ['-y', 'kept', '--flag'] });
  assert.equal(kept.enabled, false);
  const first = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(first.mcpServers.kept?.timeout, 10_000);
  assert.equal(first.mcpServers.kept?.autoload, false);
  assert.deepEqual(first.disabledServers, ['denied']);

  // Enabling a denylisted server must also remove the entry that blocks it.
  const enabled = await service.update('global', 'denied', { enabled: true });
  assert.equal(enabled.enabled, true);
  const second = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(second.disabledServers, undefined);
});

test('an installed package is found from a launcher spec, an installed binary, or the catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerFile = join(root, 'provision-ledger.json');
  await writeFile(ledgerFile, JSON.stringify({
    version: 1,
    packages: {
      uv: { mempalace: { spec: 'mempalace', version: '0.4.2', status: 'installed' } },
      pip: {},
      npm: {
        // The ledger is keyed by the bare name the installer resolved.
        '@playwright/mcp': { spec: '@playwright/mcp@latest', version: '2.1.0', status: 'installed' },
        'api-anything': { spec: 'api-anything', version: '1.9.0', status: 'installed' },
      },
      aqua: {},
    },
  }));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: {
      mempalace: { type: 'stdio', command: '/root/.gjc/app/bin/mempalace-mcp', args: [] },
      'api-anything': { type: 'stdio', command: '/data/npm-global/bin/api-anything', args: [] },
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      canvas: { type: 'http', url: 'https://canvas.example/mcp' },
    },
  }));
  const service = new McpService({ agentDir: root, ledgerPath: ledgerFile });

  const rows = await service.list('global');
  const row = (name: string) => rows.find((server) => server.name === name);

  // `npx -y pkg@latest`: the tag is not part of the package name the ledger holds.
  assert.equal(row('playwright')?.packageName, '@playwright/mcp');
  assert.equal(row('playwright')?.install?.version, '2.1.0');

  // A command that is the installed binary, not a launcher, is still a package.
  assert.equal(row('api-anything')?.pinnable, true);
  assert.equal(row('api-anything')?.packageName, 'api-anything');
  assert.equal(row('api-anything')?.install?.version, '1.9.0');

  // MemPalace's binary name differs from its package, so the catalog names it.
  assert.equal(row('mempalace')?.pinnable, true);
  assert.equal(row('mempalace')?.packageName, 'mempalace');
  assert.equal(row('mempalace')?.install?.version, '0.4.2');

  // A remote server is not a package and stays unpinnable.
  assert.equal(row('canvas')?.pinnable, false);

  const pinned = await service.pin('global', 'mempalace', '0.4.0');
  assert.equal(pinned.pin, '0.4.0');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as { packages: { uv: Record<string, { pin?: string }> } };
  assert.equal(ledger.packages.uv.mempalace?.pin, '0.4.0');
});

test('a linked binary names the package that owns it, even when the console script differs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-linked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerFile = join(root, 'provision-ledger.json');
  await writeFile(ledgerFile, JSON.stringify({
    version: 1,
    packages: {
      uv: { 'opencode-mcp': { spec: 'opencode-mcp', version: '0.9.1', status: 'installed' } },
      pip: {}, npm: {}, aqua: {},
    },
  }));
  // `uv tool install` links <bin>/oc-mcp into <tools>/<package>/bin/oc-mcp, so
  // the console script carries no package name of its own.
  const toolBin = join(root, 'uv', 'opencode-mcp', 'bin');
  await mkdir(toolBin, { recursive: true });
  await writeFile(join(toolBin, 'oc-mcp'), '#!/bin/sh\n');
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await symlink(join(toolBin, 'oc-mcp'), join(binDir, 'oc-mcp'));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: { 'oc-mcp': { type: 'stdio', command: join(binDir, 'oc-mcp'), args: [] } },
  }));

  const service = new McpService({ agentDir: root, ledgerPath: ledgerFile });
  const [row] = await service.list('global');

  assert.equal(row?.packageName, 'opencode-mcp', 'the link target names the package, not the script');
  assert.equal(row?.install?.version, '0.9.1');
  assert.equal(row?.pinnable, true);
});

test('a server this app never installed still gets its catalog package and a registry version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    // Configured by hand, running a binary nothing here recorded in the ledger.
    mcpServers: { playwright: { type: 'stdio', command: '/opt/tools/bin/playwright-mcp', args: [] } },
  }));
  const asked: string[] = [];
  const service = new McpService({
    agentDir: root,
    ledgerPath: join(root, 'provision-ledger.json'),
    registryClient: {
      search: async () => ({ entries: [], nextCursor: null }),
      latestVersion: async (manager, name) => {
        asked.push(`${manager}:${name}`);
        return '0.0.85';
      },
    },
  });

  const [row] = await service.list('global');

  assert.equal(row?.packageName, '@playwright/mcp', 'the catalog names the package a bare launcher runs');
  assert.equal(row?.pinnable, true);
  assert.equal(row?.availableVersion, '0.0.85');
  assert.deepEqual(asked, ['npm:@playwright/mcp']);
});

test('a release-installed binary reports its version without pretending it can be pinned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerFile = join(root, 'provision-ledger.json');
  await writeFile(ledgerFile, JSON.stringify({
    version: 1,
    packages: {
      uv: {}, pip: {}, npm: {},
      aqua: { 'owner/tool': { spec: 'owner/tool', version: 'v1.2.3', status: 'installed' } },
    },
  }));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: { tool: { type: 'stdio', command: '/data/aqua/bin/tool', args: [] } },
  }));

  const service = new McpService({ agentDir: root, ledgerPath: ledgerFile });
  const [row] = await service.list('global');

  assert.equal(row?.packageName, 'owner/tool');
  assert.equal(row?.install?.version, 'v1.2.3', 'the recorded release tag is still the version on the row');
  assert.equal(row?.pinnable, false, 'a release tag is not a package version');
  await assert.rejects(() => service.pin('global', 'tool', 'v1.1.0'), /release/);
});

test('remote servers are not pinnable, and duplicate names are rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []) });

  const remote = await service.add({
    name: 'home-assistant', transport: 'http', url: 'https://ha.example/mcp', headers: { Authorization: 'Bearer abc' },
  });
  assert.equal(remote.pinnable, false);
  assert.equal(remote.pin, null);
  assert.equal(remote.headers.Authorization, 'Bearer abc');
  await assert.rejects(service.pin('global', 'home-assistant', '1.0.0'), /no package version to pin/u);

  await assert.rejects(
    service.add({ name: 'home-assistant', transport: 'http', url: 'https://other.example/mcp' }),
    /already exists/u,
  );
  await assert.rejects(service.add({ name: 'bad name', transport: 'stdio', command: 'x' }), /name/u);
  await assert.rejects(service.add({ name: 'no-command', transport: 'stdio' }), /needs a command/u);
});

test('browse sorting exposes name, provenance-first relevance, and provenance-blind popularity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-sort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const overlay = [
    { name: 'zeta', description: 'server curated', transport: 'stdio', command: 'npx', origin: 'curated', stars: 1 },
    { name: 'alpha', description: 'server marketplace', transport: 'stdio', command: 'npx', origin: 'marketplace', stars: 9_000 },
    { name: 'beta', description: 'server marketplace', transport: 'stdio', command: 'npx', origin: 'marketplace', stars: 100 },
    { name: 'aardvark', description: 'server marketplace', transport: 'stdio', command: 'npx', origin: 'marketplace', stars: 50 },
  ];
  const service = new McpService({
    agentDir: root,
    catalogCachePath: join(root, 'catalog-cache.json'),
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).endsWith('/catalog.json')) {
        return new Response(JSON.stringify(overlay), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  const names = async (query: Parameters<McpService['catalog']>[0]) => (
    await service.catalog(query)
  ).entries.map((entry) => entry.name);

  assert.deepEqual(await names({ source: 'overlay', sort: 'name' }), ['aardvark', 'alpha', 'beta', 'zeta']);
  assert.deepEqual(await names({ source: 'overlay', sort: 'relevance' }), ['zeta', 'alpha', 'beta', 'aardvark']);
  assert.deepEqual(await names({ source: 'overlay', sort: 'popularity' }), ['alpha', 'beta', 'aardvark', 'zeta']);

  const popular = await service.catalog({ source: 'overlay', sort: 'popularity' });
  assert.equal(popular.entries[0]?.origin, 'marketplace');
  assert.equal(popular.entries[0]?.stars, 9_000);
  const relevant = await service.catalog({ source: 'overlay', sort: 'relevance' });
  assert.equal(relevant.entries[0]?.origin, 'curated');

  // A query narrows the list, and the chosen order still applies to the rest.
  assert.deepEqual(await names({ q: 'server', source: 'overlay' }), ['zeta', 'alpha', 'beta', 'aardvark']);
  assert.deepEqual(await names({ q: 'server', source: 'overlay', sort: 'relevance' }), ['zeta', 'alpha', 'beta', 'aardvark']);
  assert.deepEqual(await names({ q: 'server', source: 'overlay', sort: 'name' }), ['aardvark', 'alpha', 'beta', 'zeta']);
  assert.deepEqual(await names({ q: 'server', source: 'overlay', sort: 'popularity' }), ['alpha', 'beta', 'aardvark', 'zeta']);
});

test('a server moves between global and project scope instead of being duplicated', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-move-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'workspace');
  await mkdir(join(project, '.gjc'), { recursive: true });
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []) });

  await service.add({ name: 'mover', transport: 'http', url: 'https://mover.example/mcp' });
  const moved = await service.move('global', 'mover', 'project', undefined, project);
  assert.equal(moved.scope, 'project');

  const globalFile = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  const projectFile = JSON.parse(await readFile(join(project, '.gjc', 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(globalFile.mcpServers.mover, undefined, 'the name lives in one file only');
  assert.equal((projectFile.mcpServers.mover as Record<string, unknown>).url, 'https://mover.example/mcp');

  // A name already in the target is a refusal, not an overwrite.
  await service.add({ name: 'mover', transport: 'http', url: 'https://other.example/mcp' });
  await assert.rejects(() => service.move('global', 'mover', 'project', undefined, project), /already exists/u);
});

// The scope menu sends a set, not a destination. A server used by two projects
// and the global config is three stored entries with one shared definition, and
// unticking the global one leaves the projects alone.
test('one server is written to every selected scope and only leaves the ones unticked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-scopes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shipping = join(root, 'shipping');
  const billing = join(root, 'billing');
  for (const project of [shipping, billing]) await mkdir(join(project, '.gjc'), { recursive: true });
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []) });

  await service.add({
    name: 'shared',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'shared-mcp'],
    env: { SHARED_TOKEN: 'secret-value' },
  });
  const written = await service.setScopes('global', 'shared', [
    { scope: 'global' },
    { scope: 'project', projectPath: shipping },
    { scope: 'project', projectPath: billing },
  ]);
  assert.deepEqual(written.map((server) => server.scope), ['global', 'project', 'project']);

  const globalFile = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  const shippingFile = JSON.parse(await readFile(join(shipping, '.gjc', 'mcp.json'), 'utf8')) as StoredFile;
  const billingFile = JSON.parse(await readFile(join(billing, '.gjc', 'mcp.json'), 'utf8')) as StoredFile;
  assert.ok(globalFile.mcpServers.shared, 'the source stays while it is still ticked');
  // Copied from the stored entry: a secret never has to travel through the
  // page, so the copies keep the value the source has.
  assert.deepEqual((shippingFile.mcpServers.shared as Record<string, unknown>).env, { SHARED_TOKEN: 'secret-value' });
  assert.ok(billingFile.mcpServers.shared);

  await service.setScopes('global', 'shared', [
    { scope: 'project', projectPath: shipping },
    { scope: 'project', projectPath: billing },
  ]);
  const afterUntick = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as StoredFile;
  assert.equal(afterUntick.mcpServers.shared, undefined, 'the unticked source is removed');
  assert.ok((JSON.parse(await readFile(join(shipping, '.gjc', 'mcp.json'), 'utf8')) as StoredFile).mcpServers.shared);

  // A set with nothing ticked has no config to write, so it is refused rather
  // than deleting the only copy through the menu.
  await assert.rejects(
    () => service.setScopes('project', 'shared', [], shipping),
    /at least one scope/u,
  );
});
