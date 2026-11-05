import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

export type VoiceConfig = {
  sttBaseUrl: string;
  ttsBaseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
};

const STORAGE_KEY = 'voiceConfig';
const EMPTY_CONFIG: VoiceConfig = { sttBaseUrl: '', ttsBaseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' };
const configFields = Object.keys(EMPTY_CONFIG) as (keyof VoiceConfig)[];
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';

function blankConfig(): VoiceConfig {
  return { ...EMPTY_CONFIG };
}

function validStoredConfig(value: unknown): VoiceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return blankConfig();

  const restored = blankConfig();
  for (const field of configFields) {
    const entry = (value as Record<string, unknown>)[field];
    if (typeof entry === 'string') restored[field] = entry;
  }
  return restored;
}

export function readVoiceConfig(): VoiceConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? validStoredConfig(JSON.parse(saved)) : blankConfig();
  } catch {
    // Invalid or inaccessible browser storage uses the empty configuration.
    return blankConfig();
  }
}

export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};

  const config = readVoiceConfig();
  const headers: Record<string, string> = {};
  const fields: Array<[keyof VoiceConfig, string]> = [
    ['apiKey', 'x-voice-api-key'],
    ['sttModel', 'x-voice-stt-model'],
    ['ttsModel', 'x-voice-tts-model'],
    ['ttsVoice', 'x-voice-tts-voice'],
  ];

  for (const [field, header] of fields) {
    if (config[field]) headers[header] = config[field];
  }

  const format = config.ttsFormat.trim();
  if (format) headers['x-voice-tts-format'] = format;
  return headers;
}

function persistConfig(config: VoiceConfig): void {
  const stored: Partial<VoiceConfig> = { ...config };
  const format = config.ttsFormat.trim();
  if (format) stored.ttsFormat = format;
  else delete stored.ttsFormat;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
}

export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() => (
    typeof window === 'undefined' ? blankConfig() : readVoiceConfig()
  ));

  useEffect(() => {
    let disposed = false;
    void authenticatedFetch('/api/voice/config')
      .then(async (response) => response.ok ? await response.json() : null)
      .then((saved) => {
        if (disposed || !saved || typeof saved !== 'object') return;
        setConfig((current) => ({
          ...current,
          ...validStoredConfig({ ...saved, apiKey: current.apiKey }),
        }));
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, []);

  const update = (patch: Partial<VoiceConfig>) => {
    setConfig((current) => {
      const replacement = { ...current, ...patch };
      try {
        persistConfig(replacement);
      } catch {
        // Browser storage may be unavailable or full.
      }
      const { apiKey: _apiKey, ...serverConfig } = replacement;
      void authenticatedFetch('/api/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverConfig),
      }).catch(() => {});
      return replacement;
    });
  };

  return { config, update };
}
