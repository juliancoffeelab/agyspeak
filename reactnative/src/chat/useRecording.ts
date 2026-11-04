import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { RecordingPresets, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';

import type { AudioInput } from './history';
import { AUDIO_FORMATS, MAX_AUDIO_BYTES } from './openRouter';
import { RecordingSession, type RecordingClip } from './RecordingSession';

function remove(uri: string) { const file = new File(uri); if (file.exists) file.delete(); }

export function useRecording(visible: boolean, submit: (audio: AudioInput) => Promise<boolean>) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const session = useMemo(() => new RecordingSession({
    permission: async () => (await getRecordingPermissionsAsync()).granted || (await requestRecordingPermissionsAsync()).granted,
    prepare: async () => {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
    },
    record: () => recorder.record({ forDuration: 120 }),
    stop: () => recorder.stop(), status: () => recorder.getStatus(), uri: () => recorder.uri,
    remove,
  }), [recorder]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    session.setActive(visible && AppState.currentState === 'active');
    const listener = AppState.addEventListener('change', next => session.setActive(visible && next === 'active'));
    return () => { listener.remove(); session.setActive(false); };
  }, [session, visible]);
  useEffect(() => () => { session.setActive(false); void session.discard(); }, [session]);
  useEffect(() => {
    if (state.phase !== 'recording') return;
    const timer = setInterval(() => session.sample(), 150);
    return () => clearInterval(timer);
  }, [session, state.phase]);

  function send() {
    return session.send(async (clip, signal) => {
      const file = new File(clip.uri);
      if (!file.exists || !file.size || file.size > MAX_AUDIO_BYTES) throw new Error('Choose a nonempty audio file under 8 MB.');
      const data = await file.base64();
      if (signal.aborted) return false;
      return submit({ data, format: clip.format, durationMillis: clip.durationMillis, levels: clip.levels });
    });
  }
  async function attach() {
    const selected = await session.pick(async (): Promise<RecordingClip | null> => {
      const result = await getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return null;
      const format = asset.name.split('.').at(-1)?.toLowerCase() ?? '';
      const file = new File(asset.uri);
      if (!AUDIO_FORMATS.includes(format) || !file.size || file.size > MAX_AUDIO_BYTES) {
        remove(asset.uri);
        throw new Error('Choose a supported audio file under 8 MB.');
      }
      return { uri: asset.uri, format };
    });
    if (selected) await send();
  }
  return { state, start: () => session.start(), discard: () => session.discard(), send, attach };
}
