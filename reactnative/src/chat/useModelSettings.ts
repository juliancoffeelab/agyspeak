import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
import { DEFAULT_SETTINGS, parseKeyInput } from './settings';
import { createModelSettingsStorage } from './modelSettingsStorage';
import type { ModelSettings } from './openRouter';

const storage = createModelSettingsStorage({
  get: key => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: key => SecureStore.deleteItemAsync(key),
}, {
  get: key => Storage.getItemAsync(key),
  set: (key, value) => Storage.setItemAsync(key, value),
});

export function useModelSettings() {
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void storage.read().then(value => {
      if (mounted) setSettings(value);
    }).catch(() => {
      if (mounted) setError('Couldn’t read OpenRouter settings. Open Settings to reconnect.');
    }).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  async function saveKey(input: string) {
    const apiKey = input.trim() ? parseKeyInput(input) : '';
    await storage.saveKey(apiKey);
    setSettings(previous => ({ ...previous, apiKey }));
    setError(null);
  }
  async function saveModel(input: string) {
    const model = input.trim() || DEFAULT_SETTINGS.model;
    try {
      await storage.saveModel(model);
      setSettings(previous => ({ ...previous, model }));
      setError(null);
    } catch (cause) {
      setError('Couldn’t save model selection. Open Settings to retry.');
      throw cause;
    }
  }
  return { settings, ready, error, saveKey, saveModel };
}
