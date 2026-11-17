import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readMemoryBlocks, writeMemoryBlocks } from './memory.config.js';
import { MemoryService } from './memory.service.js';
import { mempalaceProjectInitialized } from './mempalace.js';

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

test('MemPalace runs beside the backend instead of replacing it', async (t) => {
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

  const enabled = await service.update({ mempalace: true });
  assert.equal(enabled.backend, 'local', 'the configured backend is left alone');
  assert.equal(enabled.mempalace.enabled, true);
  assert.equal(enabled.mempalace.mcpServer, 'enabled');
  assert.equal(enabled.mempalace.hookInstalled, true);

  const config = readMemoryBlocks(await readFile(path.join(agent, 'config.yml'), 'utf8'));
  assert.deepEqual(config.memory, { backend: 'local' }, 'local recall keeps running');

  const mcp = JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string; enabled?: boolean }>;
  };
  assert.equal(mcp.mcpServers.mempalace?.command, 'mempalace-mcp');
  assert.equal(mcp.mcpServers.mempalace?.enabled, true);
  assert.equal(mcp.mcpServers.context7?.command, 'npx');

  // A MemPalace enabled before the page existed has no marker file; the MCP
  // entry plus the hook still identify what is running.
  await rm(path.join(agent, 'memory-provider.json'), { force: true });
  assert.equal((await service.status()).mempalace.enabled, true);

  const hook = await readFile(path.join(agent, 'hooks', 'post', 'mempalace-autosave.ts'), 'utf8');
  assert.match(hook, /MEMPALACE_BIN/);
  assert.match(hook, /session_shutdown/);

  // Switching the backend must not turn MemPalace off, and disabling MemPalace
  // must not touch the backend either.
  const off = await service.update({ provider: 'off' });
  assert.equal(off.backend, 'off');
  assert.equal(off.mempalace.enabled, true);
  assert.equal(off.mempalace.mcpServer, 'enabled');

  const disabled = await service.update({ mempalace: false });
  assert.equal(disabled.backend, 'off');
  assert.equal(disabled.mempalace.enabled, false);
  assert.equal(disabled.mempalace.mcpServer, 'disabled');

  const after = JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string; enabled?: boolean }>;
  };
  assert.equal(after.mcpServers.mempalace?.enabled, false);
  assert.equal(after.mcpServers.context7?.command, 'npx', 'other servers are left alone');
});

test('enabling MemPalace installs the tool when the binary is missing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent');
  const binDir = path.join(root, 'bin');
  await mkdir(agent, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(agent, 'config.yml'), 'memory:\n  backend: off\n');
  await writeFile(path.join(agent, 'mcp.json'), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);

  // A stand-in uv that drops the console scripts where uv would put them.
  const uv = [
    '#!/bin/sh',
    'set -e',
    'mkdir -p "$UV_TOOL_BIN_DIR"',
    'printf \'#!/bin/sh\\necho MemPalace 9.9.9\\n\' > "$UV_TOOL_BIN_DIR/mempalace"',
    'cp "$UV_TOOL_BIN_DIR/mempalace" "$UV_TOOL_BIN_DIR/mempalace-mcp"',
    'chmod +x "$UV_TOOL_BIN_DIR/mempalace" "$UV_TOOL_BIN_DIR/mempalace-mcp"',
  ].join('\n');
  await writeFile(path.join(binDir, 'uv'), uv);
  await chmod(path.join(binDir, 'uv'), 0o755);

  const env = {
    ...process.env,
    HOME: root,
    GJC_WORKER_AGENT_DIR: agent,
    MEMPALACE_BIN_DIR: binDir,
    MEMPALACE_CONFIG_DIR: path.join(root, 'mempalace'),
    // The stand-in uv still needs the shell utilities it calls.
    PATH: `${binDir}:/usr/bin:/bin`,
  };
  const service = new MemoryService(env);
  assert.equal((await service.status()).mempalace.installed, false);

  const view = await service.update({ mempalace: true });
  assert.equal(view.mempalace.installed, true, 'selecting MemPalace installs it');
  assert.equal(view.mempalace.version, '9.9.9');

  const mcp = JSON.parse(await readFile(path.join(agent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string }>;
  };
  assert.equal(mcp.mcpServers.mempalace?.command, path.join(binDir, 'mempalace-mcp'), 'the entry points at the installed binary');
});

test('project status detects folders that mempalace init already wrote', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ready = path.join(root, 'ready');
  const fresh = path.join(root, 'fresh');
  await mkdir(ready, { recursive: true });
  await mkdir(fresh, { recursive: true });
  await writeFile(path.join(ready, 'mempalace.yaml'), 'wing: ready\n');

  const service = new MemoryService({ ...process.env, HOME: root, GJC_WORKER_AGENT_DIR: path.join(root, 'agent'), PATH: '' });

  assert.equal(mempalaceProjectInitialized(ready), true);
  assert.equal(mempalaceProjectInitialized(fresh), false);
  assert.deepEqual(await service.projectStatus({ paths: [ready, fresh, 'relative/path'] }), {
    projects: [
      { path: ready, initialized: true },
      { path: fresh, initialized: false },
    ],
    initialized: [ready],
  });
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

  assert.equal(view.backend, 'hindsight');
  assert.equal(view.hindsight.hasToken, true);
  assert.equal(view.hindsight.apiUrl, 'http://h:9999');
  assert.equal(readMemoryBlocks(await readFile(path.join(agent, 'config.yml'), 'utf8')).memory.backend, 'hindsight');
});
