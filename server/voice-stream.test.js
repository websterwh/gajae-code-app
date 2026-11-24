import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

// The proxy resolves its saved config beside DATABASE_PATH at import time.
const directory = mkdtempSync(path.join(tmpdir(), 'voice-stream-'));
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
delete process.env.VOICE_API_BASE_URL;
const { handleVoiceStreamConnection } = await import('./voice-proxy.js');

after(() => rmSync(directory, { recursive: true, force: true }));

function configure(baseUrl) {
  writeFileSync(path.join(directory, 'voice-config.json'), JSON.stringify({ sttBaseUrl: baseUrl }));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function appServer(t) {
  const server = http.createServer(express());
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => handleVoiceStreamConnection(client, request));
  });
  const port = await listen(server);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port };
}

async function speechBackend(t) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  const seen = { url: '', authorization: '', frames: [], audioBytes: 0, ended: false };
  let accept;
  const connection = new Promise((resolve) => { accept = resolve; });
  sockets.on('connection', (socket, request) => {
    seen.url = request.url ?? '';
    seen.authorization = String(request.headers.authorization ?? '');
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        seen.audioBytes += data.length;
        return;
      }
      const frame = JSON.parse(String(data));
      if (frame.type === 'end') seen.ended = true;
      else seen.frames.push(frame);
    });
    accept(socket);
  });
  const port = await listen(server);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, seen, connection };
}

/** Ordered inbound frames, so a message that arrives early is not lost. */
function inbox(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (data) => {
    const value = JSON.parse(String(data));
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('relays provider partials, forwards pcm, and completes on end', { timeout: 10_000 }, async (t) => {
  const speech = await speechBackend(t);
  configure(`http://127.0.0.1:${speech.port}`);
  const app = await appServer(t);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice/stream`);
  t.after(() => socket.terminate());
  const next = inbox(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'config', sttApiKey: 'fixture-key', sttModel: 'phonon-2.5-en' }));
  assert.deepEqual(await next(), { type: 'ready' });
  const provider = await speech.connection;
  assert.equal(speech.seen.url, '/audio/stream');
  assert.equal(speech.seen.authorization, 'Bearer fixture-key');
  await waitUntil(() => speech.seen.frames.length === 1);
  assert.deepEqual(speech.seen.frames[0], { sample_rate: 16000, format: 'pcm_s16le' });

  socket.send(Buffer.from([1, 2, 3, 4]));
  await waitUntil(() => speech.seen.audioBytes === 4);

  provider.send(JSON.stringify({ type: 'partial', text: 'hel' }));
  assert.deepEqual(await next(), { type: 'partial', text: 'hel' });
  provider.send(JSON.stringify({ type: 'final', text: 'hello', segment: 1 }));
  assert.deepEqual(await next(), { type: 'final', text: 'hello', segment: 1 });

  socket.send(JSON.stringify({ type: 'end' }));
  await waitUntil(() => speech.seen.ended);
  provider.send(JSON.stringify({ type: 'done', text: 'hello' }));
  assert.deepEqual(await next(), { type: 'done', text: 'hello' });
  assert.equal((await once(socket, 'close'))[0], 1000);
});

test('refuses a stream when no speech backend is configured', { timeout: 10_000 }, async (t) => {
  configure('');
  const app = await appServer(t);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice/stream`);
  t.after(() => socket.terminate());
  const next = inbox(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'config' }));
  assert.deepEqual(await next(), { type: 'error', message: 'No speech recognition backend configured' });
  assert.equal((await once(socket, 'close'))[0], 1008);
});
