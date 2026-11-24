import { authenticatedFetch } from '../utils/api';
import { readVoiceConfig, voiceConfigHeaders } from '../hooks/useVoiceConfig';

export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/** Same-origin WebSocket the server bridges to the backend's live stream. */
export function voiceStreamAddress(): string {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
  return `${secure ? 'wss:' : 'ws:'}//${host}/api/voice/stream`;
}

/** Stream configuration for the first frame; a browser socket cannot set headers. */
export function voiceStreamHandshake(): { sttApiKey?: string; sttModel?: string } {
  const config = readVoiceConfig();
  const handshake: { sttApiKey?: string; sttModel?: string } = {};
  const apiKey = config.sttApiKey.trim();
  const model = config.sttModel.trim();
  if (apiKey) handshake.sttApiKey = apiKey;
  if (model) handshake.sttModel = model;
  return handshake;
}

export function transcribeVoice(blob: Blob, filename: string): Promise<Response> {
  const body = new FormData();
  body.append('audio', blob, filename);
  return authenticatedFetch('/api/voice/transcribe', {
    method: 'POST',
    headers: voiceConfigHeaders(),
    body,
  });
}

export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const boundedText = text.trim().slice(0, 2_000);
  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text: boundedText }),
    headers: voiceConfigHeaders(),
    signal,
  });
}
