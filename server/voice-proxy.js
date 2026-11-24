// Optional voice proxy — forwards STT/TTS to an OpenAI-compatible audio backend.
//
// The backend is whatever the user points at: OpenAI, Groq, or a local server
// (LocalAI / Speaches / Kokoro-FastAPI / openedai-speech / etc.). It must expose the
// standard OpenAI audio endpoints:
//     POST {base}/audio/transcriptions   (multipart 'file' + 'model')      -> { text }
//     POST {base}/audio/speech           ({ model, voice, input })         -> audio bytes
//
// Config is resolved per-request from headers (set by the client's voice settings),
// falling back to server env defaults. Mounted at /api/voice behind authenticateToken.
import { Readable, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import express from 'express';
import { WebSocket } from 'ws';

import { asyncHandler } from './shared/utils.js';

const CONFIG_PATH = join(
  dirname(process.env.DATABASE_PATH || join(process.env.HOME || '/root', '.gajae-app', 'auth.db')),
  'voice-config.json',
);
const ENV = {
  baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
  apiKey: process.env.VOICE_API_KEY || '',
  sttStreamProtocol: process.env.VOICE_STREAM_PROTOCOL || 'auto',
  sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
  ttsModel: process.env.VOICE_TTS_MODEL || 'kokoro',
  ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
};

function text(value, maxLength = 512) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function savedConfig() {
  try {
    const value = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function voiceConfig() {
  const saved = savedConfig();
  return {
    sttBaseUrl: text(saved.sttBaseUrl) || ENV.baseUrl,
    ttsBaseUrl: text(saved.ttsBaseUrl) || ENV.baseUrl,
    sttModel: text(saved.sttModel, 128) || ENV.sttModel,
    sttStreamProtocol: normalizeStreamProtocol(saved.sttStreamProtocol || ENV.sttStreamProtocol),
    ttsVoice: text(saved.ttsVoice, 128) || ENV.ttsVoice,
    ttsFormat: text(saved.ttsFormat, 32),
  };
}

/**
 * Resolve the voice backend config for a request. Client headers (set from the
 * user's in-app voice settings) take precedence over the server env defaults.
 * @param {import('express').Request} req
 * @returns {{sttBaseUrl: string, ttsBaseUrl: string, sttApiKey: string, ttsApiKey: string, sttModel: string, sttStreamProtocol: string, ttsModel: string, ttsVoice: string, ttsFormat: string}}
 */
function resolveConfig(req) {
  const h = req.headers;
  const saved = voiceConfig();
  return {
    // Security: do not allow clients to control the outbound backend host.
    // Always use the server-side configured base URLs.
    sttBaseUrl: saved.sttBaseUrl,
    ttsBaseUrl: saved.ttsBaseUrl,
    sttApiKey: String(h['x-voice-stt-api-key'] || h['x-voice-api-key'] || '') || ENV.apiKey,
    ttsApiKey: String(h['x-voice-tts-api-key'] || h['x-voice-api-key'] || '') || ENV.apiKey,
    sttModel: String(h['x-voice-stt-model'] || '') || saved.sttModel,
    sttStreamProtocol: saved.sttStreamProtocol,
    ttsModel: ENV.ttsModel,
    ttsVoice: String(h['x-voice-tts-voice'] || '') || saved.ttsVoice,
    ttsFormat: String(h['x-voice-tts-format'] || '').trim() || saved.ttsFormat,
  };
}

const router = express.Router();

// Generous by default — local TTS can synthesize long messages at ~real-time on CPU.
// Guard against a non-numeric/zero override that would make setTimeout fire immediately.
const DEFAULT_VOICE_TIMEOUT_MS = 300000;
const _parsedTimeout = Number(process.env.VOICE_TIMEOUT_MS);
const VOICE_TIMEOUT_MS = Number.isFinite(_parsedTimeout) && _parsedTimeout > 0
  ? _parsedTimeout
  : DEFAULT_VOICE_TIMEOUT_MS;

/**
 * fetch() with an AbortController timeout so a stalled backend can't hold the
 * request open indefinitely. Aborts after VOICE_TIMEOUT_MS.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowedBackendUrl(parsed.origin)) {
    throw new Error('Blocked outbound voice backend URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  try {
    return await fetch(parsed.toString(), { redirect: 'manual', ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a backend fetch failure into a clear, actionable client response:
 * 504 on timeout (AbortError), 502 otherwise.
 * @param {import('express').Response} res
 * @param {Error} e
 */
function backendError(res, e) {
  if (e && e.name === 'AbortError') {
    return res.status(504).json({
      error: `Voice backend timed out after ${Math.round(VOICE_TIMEOUT_MS / 1000)}s. Check your voice backend.`,
    });
  }
  return res.status(502).json({ error: `Voice backend unreachable: ${e.message}` });
}

/**
 * SSRF guard for the user-configurable backend URL: allow http/https only and
 * block the link-local / cloud-metadata range (169.254.x). localhost and private
 * ranges are allowed on purpose so users can point at a local voice server
 * (LocalAI, Speaches, Kokoro-FastAPI, etc.).
 * @param {string} raw
 * @returns {boolean}
 */
function isAllowedBackendUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === '169.254.169.254' || u.hostname.startsWith('169.254.')) return false;
  return true;
}

/**
 * Relay an upstream (backend) error to the client without making an upstream
 * 401/403 look like the user's own app login failed.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} [text]
 */
function upstreamError(res, status, text) {
  if (status === 401 || status === 403) {
    return res.status(502).json({ error: 'Voice backend rejected the request (check the API key).' });
  }
  return res.status(status).json({ error: text || 'voice backend error' });
}

/**
 * Await both Multer's callback and the owned memory pipelines. On request abort
 * Multer may call next before its storage callbacks have completed.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function receiveAudio(req, res) {
  const multer = (await import('multer')).default;
  const operations = [];
  const upload = multer({
    storage: {
      _handleFile: (_request, file, done) => {
        const chunks = [];
        const output = new Writable({
          write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
        });
        operations.push(pipeline(file.stream, output).then(() => {
          const buffer = Buffer.concat(chunks);
          chunks.length = 0;
          done(null, { buffer, size: buffer.length });
        }, (error) => {
          chunks.length = 0;
          done(error);
        }));
      },
      _removeFile: (_request, file, done) => { delete file.buffer; done(null); },
    },
    limits: { fileSize: 25 * 1024 * 1024 },
  });
  // The abort can land while the dynamic import above is still resolving. Multer
  // then attaches to a request that is already gone and never calls back, which
  // would leave this route - and its admission lease - waiting forever, so the
  // abort itself settles the receive.
  const failure = await new Promise((resolve) => {
    const finish = (error) => {
      req.off('aborted', aborted);
      resolve(error ?? null);
    };
    const aborted = () => finish(new Error('Request aborted'));
    if (req.aborted) return finish(new Error('Request aborted'));
    req.once('aborted', aborted);
    return upload.single('audio')(req, res, (error) => finish(error));
  }).catch((error) => error);
  const storageFailures = [];
  for (let settled = 0; settled < operations.length;) {
    const batch = operations.slice(settled);
    settled += batch.length;
    const results = await Promise.allSettled(batch);
    for (const result of results) if (result.status === 'rejected') storageFailures.push(result.reason);
  }
  if (failure || req.aborted || storageFailures.length) {
    if (req.file) delete req.file.buffer;
    throw failure || storageFailures[0] || new Error('Request aborted');
  }
}

/**
 * Build the Authorization header for the backend, or an empty object when no
 * key is configured (e.g. a local server that needs none).
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function authHeader(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Phonon accepts WAV reliably while browser MediaRecorder output is usually
 * WebM/Opus. Convert in memory so the frontend remains browser-native and no
 * temporary audio files are retained on disk. A missing FFmpeg falls back to
 * the original bytes for backends that accept browser audio directly.
 * @param {Buffer} input
 * @returns {Promise<{ bytes: Buffer, type: string, filename: string }>}
 */
async function transcriptionAudio(input) {
  try {
    const result = await new Promise((resolve, reject) => {
      const process = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-ar', '16000', '-ac', '1',
        '-f', 'wav', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      const errors = [];
      process.stdout.on('data', (chunk) => chunks.push(chunk));
      process.stderr.on('data', (chunk) => errors.push(chunk));
      process.once('error', reject);
      process.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(Buffer.concat(errors).toString('utf8').trim() || 'Audio conversion failed.'));
      });
      process.stdin.end(input);
    });
    return { bytes: result, type: 'audio/wav', filename: 'recording.wav' };
  } catch {
    // A backend that accepts a browser-native codec should receive the source
    // bytes rather than being blocked by a failed optional conversion.
    return { bytes: input, type: 'audio/webm', filename: 'recording.webm' };
  }
}

/**
 * GET /api/voice/health -> { configured } (true when a backend base URL is set).
 */
router.get('/health', asyncHandler((req, res) => {
  const cfg = resolveConfig(req);
  res.json({ configured: Boolean(cfg.sttBaseUrl || cfg.ttsBaseUrl) });
}));

router.get('/config', asyncHandler((_req, res) => {
  res.json(voiceConfig());
}));

router.put('/config', asyncHandler((req, res) => {
  const candidate = req.body;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return res.status(400).json({ error: 'Voice configuration must be an object.' });
  }
  const config = {
    sttBaseUrl: text(candidate.sttBaseUrl),
    ttsBaseUrl: text(candidate.ttsBaseUrl),
    sttModel: text(candidate.sttModel, 128),
    sttStreamProtocol: normalizeStreamProtocol(candidate.sttStreamProtocol),
    ttsVoice: text(candidate.ttsVoice, 128),
    ttsFormat: text(candidate.ttsFormat, 32),
  };
  for (const baseUrl of [config.sttBaseUrl, config.ttsBaseUrl]) {
    if (baseUrl && !isAllowedBackendUrl(baseUrl)) {
      return res.status(400).json({ error: 'Voice backend URLs must be http or https and cannot use link-local metadata addresses.' });
    }
  }
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(temporary, CONFIG_PATH);
  res.json(config);
}));

const STREAM_SAMPLE_RATE = 16000;
const OPENAI_STREAM_SAMPLE_RATE = 24000;
const STREAM_PENDING_LIMIT = 64;
const STREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
const STREAM_PROTOCOLS = ['auto', 'phonon', 'openai', 'deepgram'];

/**
 * Normalize the configured live-stream dialect. `auto` is resolved per backend
 * host: OpenAI and Deepgram run their own protocols, and every other
 * OpenAI-compatible server is assumed to speak Phonon's stream.
 * @param {unknown} value
 * @returns {'auto' | 'phonon' | 'openai' | 'deepgram'}
 */
function normalizeStreamProtocol(value) {
  const candidate = text(value, 32).toLowerCase();
  return STREAM_PROTOCOLS.includes(candidate) ? candidate : 'auto';
}

/**
 * @param {string} baseUrl
 * @param {unknown} selection
 * @returns {'phonon' | 'openai' | 'deepgram'}
 */
function selectStreamProtocol(baseUrl, selection) {
  const chosen = normalizeStreamProtocol(selection);
  if (chosen !== 'auto') return chosen;
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'phonon';
  }
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai';
  if (host === 'api.deepgram.com' || host.endsWith('.deepgram.com')) return 'deepgram';
  return 'phonon';
}

/**
 * Map a configured base URL to a WebSocket endpoint. Credentials stay in a
 * header, never the URL, because this side of the proxy is server-controlled.
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} [search]
 * @returns {string}
 */
function websocketEndpoint(baseUrl, pathname, search = '') {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = search;
  return url.toString();
}

/**
 * Keep a base that already ends in `/v1` and add it when it does not, so both
 * `https://host` and `https://host/v1` reach the same versioned endpoint.
 * @param {string} baseUrl
 * @param {string} suffix
 * @returns {string}
 */
function versionedPath(baseUrl, suffix) {
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return `${pathname.endsWith('/v1') ? pathname : `${pathname}/v1`}${suffix}`;
}

/** Phonon: `{base}/audio/stream`, JSON config then raw PCM. */
function streamEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/stream`;
  url.search = '';
  return url.toString();
}

/** OpenAI Realtime transcription: `/v1/realtime?intent=transcription`. */
function realtimeEndpoint(baseUrl) {
  return websocketEndpoint(baseUrl, versionedPath(baseUrl, '/realtime'), '?intent=transcription');
}

/** Deepgram live listen: `/v1/listen` with linear16 16 kHz PCM. */
function deepgramEndpoint(baseUrl, model) {
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(STREAM_SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
  });
  // `whisper-1` is the OpenAI-style default; Deepgram requires its own model.
  params.set('model', model && model !== 'whisper-1' ? model : 'nova-3');
  return websocketEndpoint(baseUrl, versionedPath(baseUrl, '/listen'), `?${params.toString()}`);
}

/**
 * @param {'phonon' | 'openai' | 'deepgram'} protocol
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function streamHeaders(protocol, apiKey) {
  if (!apiKey) return {};
  return { Authorization: `${protocol === 'deepgram' ? 'Token' : 'Bearer'} ${apiKey}` };
}

/**
 * Re-clock 16-bit mono PCM to the rate a provider requires. Capture is fixed at
 * 16 kHz; OpenAI's realtime endpoint only accepts 24 kHz, so it is resampled
 * here instead of changing the client's wire format per provider.
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {(chunk: Buffer | ArrayBuffer) => Buffer}
 */
function createPcmResampler(fromRate, toRate) {
  if (fromRate === toRate) return (chunk) => Buffer.from(chunk);
  const step = fromRate / toRate;
  /** @type {number[]} */
  let queue = [];
  let cursor = 0;
  return (chunk) => {
    const incoming = Buffer.from(chunk);
    for (let offset = 0; offset + 1 < incoming.length; offset += 2) {
      queue.push(incoming.readInt16LE(offset));
    }
    /** @type {number[]} */
    const output = [];
    while (cursor + 1 < queue.length) {
      const index = Math.floor(cursor);
      const fraction = cursor - index;
      const value = queue[index] + (queue[index + 1] - queue[index]) * fraction;
      output.push(Math.max(-32768, Math.min(32767, Math.round(value))));
      cursor += step;
    }
    const consumed = Math.floor(cursor);
    if (consumed > 0) {
      queue = queue.slice(consumed);
      cursor -= consumed;
    }
    const pcm = Buffer.alloc(output.length * 2);
    output.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
    return pcm;
  };
}

/**
 * Bridge an authenticated app WebSocket to a backend live-transcription stream.
 *
 * The browser cannot set headers on `WebSocket()`, so the first frame carries
 * the stream configuration and, optionally, the per-user API key. The backend
 * host still comes from server config (never the client), and the same SSRF
 * guard as the HTTP routes runs before any connection is opened. Each provider
 * dialect is normalized here to `partial`/`final`/`done`/`error`, so the client
 * only speaks one protocol; raw 16 kHz PCM flows the other way.
 *
 * @param {import('ws').WebSocket} client
 * @param {import('node:http').IncomingMessage} request
 */
export function handleVoiceStreamConnection(client, request) {
  /** @type {import('ws').WebSocket | null} */
  let upstream = null;
  let configured = false;
  let ready = false;
  let requestedEnd = false;
  let completed = false;
  let failed = false;
  let closed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let closeTimer = null;
  /** @type {Array<Buffer | ArrayBuffer>} */
  const pending = [];
  /** @type {'phonon' | 'openai' | 'deepgram'} */
  let protocol = 'phonon';
  /** @type {(chunk: Buffer | ArrayBuffer) => Buffer} */
  let resample = (chunk) => Buffer.from(chunk);
  const finals = [];
  let partial = '';

  const send = (payload) => {
    if (client.readyState !== WebSocket.OPEN) return;
    try { client.send(JSON.stringify(payload)); } catch { /* peer already gone */ }
  };
  const stopTimer = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  };
  const closeClient = (code = 1000) => {
    stopTimer();
    if (closed) return;
    closed = true;
    try { client.close(code); } catch { /* already closed */ }
  };
  const fail = (message, code = 1011) => {
    failed = true;
    send({ type: 'error', message });
    closeClient(code);
  };
  const closeUpstream = () => {
    const socket = upstream;
    upstream = null;
    try { socket?.close(); } catch { /* already closed */ }
  };

  /** Complete the phrase with whatever the provider finalized. */
  const finish = () => {
    if (completed || closed || failed) return;
    completed = true;
    send({ type: 'done', text: finals.join(' ').trim() });
    closeClient(1000);
  };

  /** Send one captured frame in the provider's own encoding. */
  const forwardAudio = (data) => {
    const socket = upstream;
    if (!ready || socket?.readyState !== WebSocket.OPEN) return;
    const audio = resample(data);
    if (protocol === 'openai') {
      socket.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(audio).toString('base64'),
      }));
      return;
    }
    socket.send(audio);
  };

  /** Stop waiting for a flush once the provider has had ample time. */
  const armTimer = () => {
    stopTimer();
    closeTimer = setTimeout(() => closeClient(1000), VOICE_TIMEOUT_MS);
  };

  /** Tell the provider no more audio is coming, in its own vocabulary. */
  const requestProviderEnd = () => {
    const socket = upstream;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      if (protocol === 'openai') socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      else if (protocol === 'deepgram') socket.send(JSON.stringify({ type: 'CloseStream' }));
      else socket.send(JSON.stringify({ type: 'end' }));
    } catch {
      return;
    }
    armTimer();
  };

  /** The provider is configured and can accept audio. */
  const announceReady = () => {
    const socket = upstream;
    if (ready || closed || failed || !socket || socket.readyState !== WebSocket.OPEN) return;
    ready = true;
    send({ type: 'ready' });
    for (const data of pending.splice(0)) {
      if (socket.readyState !== WebSocket.OPEN) break;
      forwardAudio(data);
    }
    if (requestedEnd) requestProviderEnd();
  };

  /** Deepgram `Results` -> the client's partial/final vocabulary. */
  const handleDeepgramEvent = (event) => {
    if (event.type === 'Results') {
      const transcript = event.channel?.alternatives?.[0]?.transcript;
      if (typeof transcript !== 'string' || !transcript.trim()) return;
      const value = transcript.trim();
      if (event.is_final) {
        finals.push(value);
        partial = '';
        send({ type: 'final', text: value });
      } else {
        partial = value;
        send({ type: 'partial', text: value });
      }
      return;
    }
    if (event.type === 'Metadata') {
      if (requestedEnd) finish();
      return;
    }
    if (event.type === 'Error' || event.type === 'error') {
      failed = true;
      const message = event.message ?? event.description ?? event.error;
      send({ type: 'error', message: typeof message === 'string' ? message.slice(0, 512) : 'Voice backend error' });
      closeUpstream();
    }
  };

  /** OpenAI realtime transcription events -> the same vocabulary. */
  const handleRealtimeEvent = (event) => {
    if (event.type === 'session.updated') {
      announceReady();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return;
      partial += delta;
      send({ type: 'partial', text: partial });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : partial.trim();
      partial = '';
      if (!transcript) return;
      finals.push(transcript);
      send({ type: 'final', text: transcript });
      if (requestedEnd) finish();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      failed = true;
      const message = event.error?.message;
      send({ type: 'error', message: typeof message === 'string' ? message.slice(0, 512) : 'Speech recognition failed' });
      closeUpstream();
      return;
    }
    if (event.type === 'error') {
      failed = true;
      const message = event.error?.message ?? event.message;
      send({ type: 'error', message: typeof message === 'string' ? message.slice(0, 512) : 'Voice backend error' });
      closeUpstream();
    }
  };

  /** @param {{sttApiKey?: unknown, sttModel?: unknown}} frame */
  const openUpstream = (frame) => {
    const cfg = resolveConfig(request);
    if (!cfg.sttBaseUrl) return fail('No speech recognition backend configured', 1008);
    if (!isAllowedBackendUrl(cfg.sttBaseUrl)) return fail('Invalid speech recognition backend URL.', 1008);
    protocol = selectStreamProtocol(cfg.sttBaseUrl, cfg.sttStreamProtocol);
    const model = text(frame.sttModel, 128) || cfg.sttModel;
    let endpoint;
    try {
      endpoint = protocol === 'openai' ? realtimeEndpoint(cfg.sttBaseUrl)
        : protocol === 'deepgram' ? deepgramEndpoint(cfg.sttBaseUrl, model)
          : streamEndpoint(cfg.sttBaseUrl);
    } catch {
      return fail('Invalid speech recognition backend URL.', 1008);
    }
    resample = protocol === 'openai'
      ? createPcmResampler(STREAM_SAMPLE_RATE, OPENAI_STREAM_SAMPLE_RATE)
      : (chunk) => Buffer.from(chunk);
    const apiKey = text(frame.sttApiKey, 512) || cfg.sttApiKey;
    let socket;
    try {
      socket = new WebSocket(endpoint, {
        headers: streamHeaders(protocol, apiKey),
        handshakeTimeout: STREAM_HANDSHAKE_TIMEOUT_MS,
      });
    } catch {
      return fail('Voice backend unreachable');
    }
    upstream = socket;

    socket.on('open', () => {
      if (closed) { closeUpstream(); return; }
      if (protocol === 'phonon') {
        socket.send(JSON.stringify({ sample_rate: STREAM_SAMPLE_RATE, format: 'pcm_s16le' }));
        announceReady();
        return;
      }
      if (protocol === 'deepgram') {
        announceReady();
        return;
      }
      // OpenAI accepts audio only after the transcription session is updated.
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: OPENAI_STREAM_SAMPLE_RATE },
              transcription: { model: model && model !== 'whisper-1' ? model : 'gpt-live-transcribe' },
              turn_detection: null,
            },
          },
        },
      }));
    });

    socket.on('message', (data, isBinary) => {
      if (closed) return;
      if (protocol === 'phonon') {
        if (isBinary) return;
        const raw = String(data);
        if (raw.length > 64 * 1024) return;
        let event;
        try { event = JSON.parse(raw); } catch { return; }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'done') {
          completed = true;
          if (client.readyState === WebSocket.OPEN) client.send(raw);
          closeClient(1000);
          return;
        }
        if (event.type === 'error') {
          failed = true;
          send({ type: 'error', message: typeof event.message === 'string' ? event.message.slice(0, 512) : 'Voice backend error' });
          closeUpstream();
          return;
        }
        if (client.readyState === WebSocket.OPEN) client.send(raw);
        return;
      }
      if (isBinary) return;
      const raw = String(data);
      if (raw.length > 64 * 1024) return;
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (protocol === 'deepgram') handleDeepgramEvent(event);
      else handleRealtimeEvent(event);
    });

    socket.on('close', () => {
      if (upstream === socket) upstream = null;
      if (closed) return;
      if (failed) { closeClient(1000); return; }
      // OpenAI and Deepgram close after flushing instead of sending a terminal
      // frame; the phrases they finalized are the completed phrase.
      if (protocol !== 'phonon' && requestedEnd) {
        finish();
        return;
      }
      if (!completed && !requestedEnd) send({ type: 'error', message: 'Speech recognition stream closed' });
      closeClient(1000);
    });
    socket.on('error', (error) => {
      if (upstream === socket) upstream = null;
      fail(`Voice backend unreachable: ${error.message}`);
    });
  };

  client.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (ready) forwardAudio(data);
      else if (pending.length < STREAM_PENDING_LIMIT) pending.push(data);
      return;
    }
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return fail('Invalid stream message', 1002); }
    if (!frame || typeof frame !== 'object') return fail('Invalid stream message', 1002);
    if (frame.type === 'config' && !configured) {
      configured = true;
      openUpstream(frame);
      return;
    }
    if (frame.type === 'end') {
      requestedEnd = true;
      if (ready) requestProviderEnd();
      else if (!upstream) closeClient(1000);
      // While the upstream is still connecting, `announceReady` sends the end.
    }
  });
  client.on('close', () => {
    stopTimer();
    closed = true;
    closeUpstream();
  });
  client.on('error', () => {
    stopTimer();
    closed = true;
    closeUpstream();
  });
}

/**
 * POST /api/voice/transcribe (multipart 'audio') -> { text }.
 * Forwards the uploaded audio to the backend's /audio/transcriptions endpoint.
 */
router.post('/transcribe', asyncHandler(async (req, res) => {
  const cfg = resolveConfig(req);
  if (!cfg.sttBaseUrl) return res.status(503).json({ error: 'No speech recognition backend configured' });
  if (!isAllowedBackendUrl(cfg.sttBaseUrl)) return res.status(400).json({ error: 'Invalid speech recognition backend URL.' });
  try {
    await receiveAudio(req, res);
  } catch (err) {
    // Multer's wording for an unexpected field has changed between releases
    // ("Unexpected field" became "Unexpected file field"); the client contract
    // is the field name, not the library's phrasing.
    if (err?.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected field' });
    return res.status(400).json({ error: err.message });
  }
  if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
  try {
    const audio = await transcriptionAudio(req.file.buffer);
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([audio.bytes], { type: audio.type }),
      audio.filename,
    );
    fd.append('model', cfg.sttModel);
    const r = await fetchWithTimeout(`${cfg.sttBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeader(cfg.sttApiKey),
      body: fd,
    });
    const text = await r.text();
    if (!r.ok) return upstreamError(res, r.status, text);
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    res.json({ text: data.text ?? '' });
  } catch (e) {
    backendError(res, e);
  }
}));

/**
 * POST /api/voice/tts { text } -> audio bytes.
 * Forwards the text to the backend's /audio/speech endpoint and streams the audio back.
 */
router.post('/tts', asyncHandler(async (req, res) => {
  const cfg = resolveConfig(req);
  if (!cfg.ttsBaseUrl) return res.status(503).json({ error: 'No speech synthesis backend configured' });
  if (!isAllowedBackendUrl(cfg.ttsBaseUrl)) return res.status(400).json({ error: 'Invalid speech synthesis backend URL.' });
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const r = await fetchWithTimeout(`${cfg.ttsBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(cfg.ttsApiKey) },
      body: JSON.stringify({
        model: cfg.ttsModel,
        voice: cfg.ttsVoice,
        input: text,
        ...(cfg.ttsFormat ? { response_format: cfg.ttsFormat } : {}),
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => 'tts failed');
      return upstreamError(res, r.status, errText);
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (!r.body) return res.end();
    const source = Readable.fromWeb(r.body);
    const sourceClosed = new Promise((resolve) => source.once('close', resolve));
    const stopSource = () => { source.destroy(); };
    const reportError = (error) => { res.destroy(error); };
    source.on('error', reportError);
    res.once('close', stopSource);
    const responseDone = finished(res, { cleanup: true }).catch(stopSource);
    try {
      if (res.destroyed) stopSource();
      else source.pipe(res);
      // Readable.fromWeb's close follows its async cancel/_destroy callback.
      // A closed client alone must not release the backend stream's ownership.
      await Promise.all([sourceClosed, responseDone]);
    } catch (error) {
      res.destroy(error);
      throw error;
    } finally {
      stopSource();
      await Promise.all([sourceClosed, responseDone]);
      res.off('close', stopSource);
      source.off('error', reportError);
    }
  } catch (e) {
    if (res.headersSent || res.destroyed) res.destroy(e);
    else backendError(res, e);
  }
}));

export default router;
