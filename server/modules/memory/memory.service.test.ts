import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readMemoryBlocks, writeMemoryBlocks } from './memory.config.js';
import { MemoryService } from './memory.service.js';

test('writing the memory block leaves the rest of config.yml untouched', () => {
  const original = ['memory: ', '  backend: local', 'notifications:', '  enabled: true', ''].join('\n');
  const next = writeMemoryBlocks(original, { memory: { backend: 'off' } });

  assert.equal(next, ['memory:', '  backend: off', 'notifications:', '  enabled: true', ''].join('\n'));
  assert.deepEqual(readMemoryBlocks(next).memory, { backend: 'off' });
  // A block that was absent is appended, not merged into a neighbour.
  assert.deepEqual(readMemoryBlocks(writeMemoryBlocks('theme: dark\n', { hindsight: { apiUrl: 'http://h:8888' } })).hindsight, {
    apiUrl: 'http://h:8888',
  });
});

test('switching to MemPalace wires the MCP server and hook; switching away disables it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, 'config.yml'), 'memory: \n  backend: local\nnotifications:\n  enabled: true\n');
  await writeFile(path.join(agent, 'mcp.json'), `${JSON.stringify({
    mcpServers: {
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    },
  }, null, 2)}\n`);

  const env = { ...process.env, HOME: root, GJC_WORKER_AGENT_DIR: agent, PATH: '' };
  const service = new MemoryService(env);

  const enabled = await service.update({ provider: 'mempalace' });
  assert.equal(enabled.provider, 'mempalace');
  assert.equal(enabled.mempalace.enabled, true);
  assert.equal(enabled.mempalace.mcpServer, 'enabled');
  assert.equal(enabled.mempalace.hookInstalled, true);
  assert.equal(enabled.mempalace.palacePath, path.join(root, '.mempalace', 'palace'));

  const config = readMemoryBlocks(await readFile(path.join(agent, 'config.yml'), 'utf8'));
  assert.deepEqual(config.memory, { backend: 'off' });

  const mcp = JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string; enabled?: boolean }>;
  };
  assert.equal(mcp.mcpServers.mempalace?.command, 'mempalace-mcp');
  assert.equal(mcp.mcpServers.mempalace?.enabled, true);
  assert.equal(mcp.mcpServers.context7?.command, 'npx');

  // A MemPalace enabled before the page existed has no marker file; the MCP
  // entry plus the hook still identify the provider that is running.
  await rm(path.join(agent, 'memory-provider.json'), { force: true });
  assert.equal((await service.status()).provider, 'mempalace');

  const hook = await readFile(path.join(agent, 'hooks', 'post', 'mempalace-autosave.ts'), 'utf8');
  assert.match(hook, /MEMPALACE_BIN/);
  assert.match(hook, /session_shutdown/);

  const disabled = await service.update({ provider: 'off' });
  assert.equal(disabled.provider, 'off');
  assert.equal(disabled.mempalace.enabled, false);
  assert.equal(disabled.mempalace.mcpServer, 'disabled');

  const after = JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string; enabled?: boolean }>;
  };
  assert.equal(after.mcpServers.mempalace?.enabled, false);
  assert.equal(after.mcpServers.context7?.command, 'npx', 'other servers are left alone');
});

test('a blank Hindsight token keeps the stored one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, 'config.yml'), 'memory:\n  backend: off\n');

  const service = new MemoryService({ ...process.env, HOME: root, GJC_WORKER_AGENT_DIR: agent, PATH: '' });
  await service.update({ provider: 'hindsight', hindsight: { apiToken: 'secret-token', apiUrl: 'http://h:9999' } });
  const view = await service.update({ provider: 'hindsight', hindsight: { apiToken: '' } });

  assert.equal(view.provider, 'hindsight');
  assert.equal(view.hindsight.hasToken, true);
  assert.equal(view.hindsight.apiUrl, 'http://h:9999');
  assert.equal(readMemoryBlocks(await readFile(path.join(agent, 'config.yml'), 'utf8')).memory.backend, 'hindsight');
});
