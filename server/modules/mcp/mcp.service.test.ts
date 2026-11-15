import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { McpService } from './mcp.service.js';
import { REDACTED } from './mcp.config.js';

type StoredFile = { mcpServers: Record<string, Record<string, unknown>> };

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function all(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1] as string);
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
  // No secret ever leaves via list/get; only the placeholder and isSet.
  assert.equal(added.env.API_TOKEN, REDACTED);
  assert.equal(added.envIsSet.API_TOKEN, true);
  assert.equal(JSON.stringify(added).includes('super-secret'), false);
  // Spawning is argv-only: the secret is one argument, never a shell string.
  assert.deepEqual(calls[0]?.slice(0, 2), ['mcp', 'add']);
  assert.ok(calls[0]?.includes('API_TOKEN=super-secret'));

  const listed = await service.list('global');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, 'custom');

  const toggled = await service.update('global', 'custom', { enabled: false });
  assert.equal(toggled.enabled, false);

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

test('remote servers are not pinnable, and duplicate names are rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new McpService({ agentDir: root, runCli: fakeCli(root, []) });

  const remote = await service.add({
    name: 'home-assistant', transport: 'http', url: 'https://ha.example/mcp', headers: { Authorization: 'Bearer abc' },
  });
  assert.equal(remote.pinnable, false);
  assert.equal(remote.pin, null);
  assert.equal(remote.headers.Authorization, REDACTED);
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
