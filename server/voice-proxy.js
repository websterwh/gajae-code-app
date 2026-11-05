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

import express from 'express';

import { asyncHandler } from './shared/utils.js';

const CONFIG_PATH = join(
  dirname(process.env.DATABASE_PATH || join(process.env.HOME || '/root', '.gajae-app', 'auth.db')),
  'voice-config.json',
);
const ENV = {
  baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
  apiKey: process.env.VOICE_API_KEY || '',
  sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
  ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
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
    ttsModel: text(saved.ttsModel, 128) || ENV.ttsModel,
    ttsVoice: text(saved.ttsVoice, 128) || ENV.ttsVoice,
    ttsFormat: text(saved.ttsFormat, 32),
  };
}

/**
 * Resolve the voice backend config for a request. Client headers (set from the
 * user's in-app voice settings) take precedence over the server env defaults.
 * @param {import('express').Request} req
 * @returns {{sttBaseUrl: string, ttsBaseUrl: string, apiKey: string, sttModel: string, ttsModel: string, ttsVoice: string, ttsFormat: string}}
 */
function resolveConfig(req) {
  const h = req.headers;
  const saved = voiceConfig();
  return {
    // Security: do not allow clients to control the outbound backend host.
    // Always use the server-side configured base URLs.
    sttBaseUrl: saved.sttBaseUrl,
    ttsBaseUrl: saved.ttsBaseUrl,
    apiKey: String(h['x-voice-api-key'] || '') || ENV.apiKey,
    sttModel: String(h['x-voice-stt-model'] || '') || saved.sttModel,
    ttsModel: String(h['x-voice-tts-model'] || '') || saved.ttsModel,
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
  const failure = await new Promise((resolve) => upload.single('audio')(req, res, resolve)).catch((error) => error);
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
    ttsModel: text(candidate.ttsModel, 128),
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
    return res.status(400).json({ error: err.message });
  }
  if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
  try {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
      req.file.originalname || 'recording.webm',
    );
    fd.append('model', cfg.sttModel);
    const r = await fetchWithTimeout(`${cfg.sttBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeader(cfg.apiKey),
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
      headers: { 'Content-Type': 'application/json', ...authHeader(cfg.apiKey) },
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
