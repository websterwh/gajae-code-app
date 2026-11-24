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

function configure(baseUrl, sttStreamProtocol = 'auto') {
  writeFileSync(path.join(directory, 'voice-config.json'), JSON.stringify({ sttBaseUrl: baseUrl, sttStreamProtocol }));
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

async function speechBackend(t, onFrame) {
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
      onFrame?.(socket, frame);
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

test('speaks the OpenAI realtime transcription protocol and normalizes its events', { timeout: 10_000 }, async (t) => {
  let audioBytes = 0;
  const speech = await speechBackend(t, (socket, frame) => {
    if (frame.type === 'session.update') {
      socket.send(JSON.stringify({ type: 'session.updated', session: { type: 'transcription' } }));
      return;
    }
    if (frame.type === 'input_audio_buffer.append') {
      audioBytes += Buffer.from(frame.audio, 'base64').length;
      return;
    }
    if (frame.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hel' }));
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'lo' }));
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }));
    }
  });
  configure(`http://127.0.0.1:${speech.port}/v1`, 'openai');
  const app = await appServer(t);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice/stream`);
  t.after(() => socket.terminate());
  const next = inbox(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'config', sttApiKey: 'fixture-key', sttModel: 'gpt-live-transcribe' }));
  assert.deepEqual(await next(), { type: 'ready' });
  await speech.connection;
  assert.equal(speech.seen.url, '/v1/realtime?intent=transcription');
  assert.equal(speech.seen.authorization, 'Bearer fixture-key');
  await waitUntil(() => speech.seen.frames.length === 1);
  assert.equal(speech.seen.frames[0].type, 'session.update');
  assert.deepEqual(speech.seen.frames[0].session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(speech.seen.frames[0].session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(speech.seen.frames[0].session.audio.input.turn_detection, null);

  // Capture is 16 kHz; the realtime API only accepts 24 kHz PCM, so the bridge
  // resamples rather than making every provider share one capture rate.
  socket.send(Buffer.alloc(6_400));
  await waitUntil(() => audioBytes > 9_000);
  assert.ok(Math.abs(audioBytes - 9_600) <= 8, `resampled bytes: ${audioBytes}`);

  socket.send(JSON.stringify({ type: 'end' }));
  assert.deepEqual(await next(), { type: 'partial', text: 'hel' });
  assert.deepEqual(await next(), { type: 'partial', text: 'hello' });
  assert.deepEqual(await next(), { type: 'final', text: 'hello' });
  assert.deepEqual(await next(), { type: 'done', text: 'hello' });
  assert.equal((await once(socket, 'close'))[0], 1000);
});

test('speaks the Deepgram listen protocol and ends with CloseStream', { timeout: 10_000 }, async (t) => {
  const speech = await speechBackend(t, (socket, frame) => {
    if (frame.type === 'CloseStream') socket.send(JSON.stringify({ type: 'Metadata' }));
  });
  configure(`http://127.0.0.1:${speech.port}/v1`, 'deepgram');
  const app = await appServer(t);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice/stream`);
  t.after(() => socket.terminate());
  const next = inbox(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'config', sttApiKey: 'fixture-key', sttModel: 'nova-3' }));
  assert.deepEqual(await next(), { type: 'ready' });
  await speech.connection;
  assert.match(speech.seen.url, /^\/v1\/listen\?/);
  const query = new URLSearchParams(speech.seen.url.split('?')[1]);
  assert.equal(query.get('encoding'), 'linear16');
  assert.equal(query.get('sample_rate'), '16000');
  assert.equal(query.get('channels'), '1');
  assert.equal(query.get('interim_results'), 'true');
  assert.equal(query.get('model'), 'nova-3');
  assert.equal(speech.seen.authorization, 'Token fixture-key');

  socket.send(Buffer.from([1, 2, 3, 4]));
  await waitUntil(() => speech.seen.audioBytes === 4);

  speech.seen.frames.length = 0;
  const provider = await speech.connection;
  provider.send(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'hel' }] } }));
  assert.deepEqual(await next(), { type: 'partial', text: 'hel' });
  provider.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hello' }] } }));
  assert.deepEqual(await next(), { type: 'final', text: 'hello' });

  socket.send(JSON.stringify({ type: 'end' }));
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
