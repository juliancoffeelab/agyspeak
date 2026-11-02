import type { ModelSettings } from './openRouter';

export const DEFAULT_SETTINGS: ModelSettings = { apiKey: '', model: 'openrouter/free' };

export function parseKeyInput(input: string): string {
  let value = input.trim();
  if (value.startsWith('{')) {
    const payload: unknown = JSON.parse(value);
    if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'agyspeak.openrouter-key'
      || !('version' in payload) || payload.version !== 1 || !('key' in payload) || typeof payload.key !== 'string') {
      throw new Error('This QR code does not contain an AGSpeak OpenRouter key.');
    }
    value = payload.key.trim();
  }
  value = value.replace(/^Bearer\s+/i, '');
  if (!/^sk-or-[A-Za-z0-9_-]{16,2048}$/.test(value)) throw new Error('That does not look like an OpenRouter API key.');
  return value;
}

export function decodeSettings(value: string | null): ModelSettings {
  if (!value) return { ...DEFAULT_SETTINGS };
  const data: unknown = JSON.parse(value);
  if (typeof data !== 'object' || data === null || !('apiKey' in data) || typeof data.apiKey !== 'string'
    || !('model' in data) || typeof data.model !== 'string' || !data.model.trim()) throw new Error('Saved settings are invalid.');
  return { apiKey: data.apiKey ? parseKeyInput(data.apiKey) : '', model: data.model.trim() };
}
