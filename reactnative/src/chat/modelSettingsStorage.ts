import { decodeSettings, DEFAULT_SETTINGS, parseKeyInput } from './settings.ts';
import type { ModelSettings } from './openRouter';

type Store = { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void> };
export const LEGACY_SETTINGS_KEY = 'agyspeak.openrouter.v1';
export const API_KEY_STORAGE_KEY = 'agyspeak.openrouter.api-key.v1';
export const MODEL_STORAGE_KEY = 'agyspeak.model.v1';

export function createModelSettingsStorage(secure: Store & { remove: (key: string) => Promise<void> }, preferences: Store) {
  let writes = Promise.resolve();
  function enqueue(write: () => Promise<void>) {
    const result = writes.then(write);
    writes = result.catch(() => undefined);
    return result;
  }
  return {
    async read(): Promise<ModelSettings> {
      const [key, model, legacy] = await Promise.all([
        secure.get(API_KEY_STORAGE_KEY), preferences.get(MODEL_STORAGE_KEY), secure.get(LEGACY_SETTINGS_KEY),
      ]);
      const previous = legacy !== null && (key === null || model === null) ? decodeSettings(legacy) : DEFAULT_SETTINGS;
      const settings = { apiKey: key === null ? previous.apiKey : key ? parseKeyInput(key) : '', model: model?.trim() || previous.model };
      if (legacy !== null) {
        // Remove the old combined secret only after both destinations are durable.
        await Promise.all([
          secure.set(API_KEY_STORAGE_KEY, settings.apiKey), preferences.set(MODEL_STORAGE_KEY, settings.model),
        ]);
        await secure.remove(LEGACY_SETTINGS_KEY);
      }
      return settings;
    },
    saveKey(input: string) {
      const key = input.trim() ? parseKeyInput(input) : '';
      return enqueue(() => secure.set(API_KEY_STORAGE_KEY, key));
    },
    saveModel(input: string) {
      const model = input.trim() || DEFAULT_SETTINGS.model;
      return enqueue(() => preferences.set(MODEL_STORAGE_KEY, model));
    },
  };
}
