import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGjcAutomationTools } from './gjc-automation-tools.js';

const TEST_TOKEN = 'b'.repeat(64);

test('computer use asks which connected device to use once, then routes every call there', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-computer-device-'));
  const socketPath = join(directory, 'bridge.sock');
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      const result = request.operation === 'devices'
        ? {
          selectedDeviceId: 'device-a',
          devices: [
            { id: 'device-a', name: 'Laptop', os: 'macOS', connected: true },
            { id: 'device-b', name: 'Desktop', os: 'Linux', connected: true },
            { id: 'device-c', name: 'Offline box', os: 'Linux', connected: false },
          ],
        }
        : request.operation === 'authorize'
          ? { granted: true, application: 'com.apple.TextEdit', label: 'TextEdit' }
          : { content: [{ type: 'text', text: 'clicked' }] };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  const prompts: Array<{ title: string; options: string[] }> = [];
  try {
    const { computer } = createGjcAutomationTools('app-session', {
      async select(title, options) {
        prompts.push({ title, options });
        return 'Desktop (Linux)';
      },
    }, { socketPath, token: TEST_TOKEN });
    assert.ok(computer);

    for (const id of ['use-1', 'use-2']) {
      await computer.execute(id, { action: 'desktop_click', arguments: { ref_id: '@sabc123:e1' } }, undefined);
    }

    assert.deepEqual(prompts, [{
      title: 'Which computer should the agent use?',
      options: ['Laptop (macOS)', 'Desktop (Linux)', 'Deny'],
    }], 'the picker names only connected devices, and only once per session');
    assert.deepEqual(
      requests.map((request) => request.operation),
      ['devices', 'authorize', undefined, 'authorize', undefined],
      'the device listing is read once; later calls go straight to authorize and dispatch',
    );
    for (const request of requests.slice(1)) {
      assert.equal(request.deviceId, 'device-b', 'every later call runs on the chosen device');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a denied device choice stops the call before any authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-computer-device-deny-'));
  const socketPath = join(directory, 'bridge.sock');
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          selectedDeviceId: undefined,
          devices: [
            { id: 'device-a', name: 'Laptop', os: 'macOS', connected: true },
            { id: 'device-b', name: 'Desktop', os: 'Linux', connected: true },
          ],
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    const { computer } = createGjcAutomationTools('app-session', {
      async select() { return 'Deny'; },
    }, { socketPath, token: TEST_TOKEN });
    assert.ok(computer);
    await assert.rejects(
      computer.execute('deny-1', { action: 'desktop_list_apps', arguments: {} }, undefined),
      /Computer device selection was denied/u,
    );
    assert.deepEqual(requests.map((request) => request.operation), ['devices']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
