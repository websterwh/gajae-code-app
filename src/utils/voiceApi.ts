import { authenticatedFetch } from '../utils/api';
import { readVoiceConfig, voiceConfigHeaders } from '../hooks/useVoiceConfig';

export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
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
  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: voiceConfigHeaders(),
    signal,
  });
}
