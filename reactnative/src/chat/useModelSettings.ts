import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { decodeSettings, DEFAULT_SETTINGS } from './settings';
import type { ModelSettings } from './openRouter';

const STORAGE_KEY = 'agyspeak.openrouter.v1';

export function useModelSettings() {
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void SecureStore.getItemAsync(STORAGE_KEY).then(value => {
      if (mounted) setSettings(decodeSettings(value));
    }).catch(() => {
      if (mounted) setError('Couldn’t read OpenRouter settings. Open Settings to reconnect.');
    }).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  async function save(next: ModelSettings) {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    setSettings(next);
    setError(null);
  }
  return { settings, ready, error, save };
}
