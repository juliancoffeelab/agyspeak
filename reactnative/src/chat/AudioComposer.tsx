import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync,
  useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';

import { MAX_AUDIO_BYTES, type ModelSettings } from './openRouter';
import type { AudioInput } from './history';
import type { ChatColors } from './theme';

type Props = {
  colors: ChatColors;
  disabled: boolean;
  settings: ModelSettings;
  onSend: (audio: AudioInput, settings: ModelSettings) => Promise<boolean>;
};

export function AudioComposer({ colors, disabled, settings, onSend }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const status = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [clip, setClip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && recorder.isRecording) {
        void recorder.stop().then(() => {
          if (aliveRef.current) { setClip(recorder.uri); setRecording(false); }
        }).catch(() => { if (aliveRef.current) { setRecording(false); setError('Recording was interrupted. Please try again.'); } });
      }
    });
    return () => { aliveRef.current = false; subscription.remove(); };
  }, [recorder]);

  async function run(action: () => Promise<void>) {
    if (lockRef.current) return;
    lockRef.current = true;
    setWorking(true);
    setError(null);
    try { await action(); }
    catch (cause) { if (aliveRef.current) setError(cause instanceof Error ? cause.message : 'Couldn’t record or read audio. Please try again.'); }
    finally { lockRef.current = false; if (aliveRef.current) setWorking(false); }
  }

  async function sendFile(uri: string, name: string) {
    const file = new File(uri);
    if (!file.exists || file.size === 0 || file.size > MAX_AUDIO_BYTES) throw new Error('Choose a nonempty audio file under 8 MB.');
    const format = name.split('.').at(-1)?.toLowerCase() ?? '';
    const audio = { data: await file.base64(), format };
    if (!aliveRef.current) return;
    if (await onSend(audio, settings)) {
      setClip(null);
      // The pending turn now owns a durable copy in SQLite.
      try { file.delete(); } catch { /* The OS can reclaim this cache file. */ }
    }
  }

  async function tapMic() {
    if (recording) {
      if (recorder.isRecording) await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (!uri) throw new Error('No recording was saved. Please try again.');
      setClip(uri);
      await sendFile(uri, 'recording.m4a');
    } else if (clip) {
      await sendFile(clip, 'recording.m4a');
    } else {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Allow microphone access in Android settings to record a voice message.');
      if (!aliveRef.current) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!aliveRef.current) return;
      recorder.record({ forDuration: 120 });
      setRecording(true);
    }
  }

  function discard() {
    void run(async () => {
      if (recorder.isRecording) await recorder.stop();
      const uri = clip ?? recorder.uri;
      setRecording(false);
      setClip(null);
      if (uri) { const file = new File(uri); if (file.exists) file.delete(); }
    });
  }

  const seconds = Math.floor(status.durationMillis / 1000);
  return <View style={styles.container}>
    <Text style={{ color: colors.muted }}>{recording ? `Recording · ${seconds}s / 120s · tap to send` : clip ? 'Recording ready to send' : 'Voice · Gemini 3.8 Flash'}</Text>
    {error !== null && <Text accessibilityRole="alert" style={{ color: colors.text }}>{error}</Text>}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Send recording' : clip ? 'Send saved recording' : 'Record voice message'}
        disabled={disabled || working} onPress={() => { void run(tapMic); }}
        style={[styles.primary, { backgroundColor: colors.button, opacity: disabled || working ? 0.4 : 1 }]}>
        <Text style={{ color: colors.buttonText }}>{working ? 'Please wait…' : recording ? 'Send recording' : clip ? 'Send recording' : 'Record'}</Text>
      </Pressable>
      {recording || clip ? <Pressable accessibilityRole="button" disabled={working} onPress={discard} style={styles.action}>
        <Text style={{ color: colors.text }}>Discard</Text>
      </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="Send audio file" disabled={disabled || working}
        onPress={() => { void run(async () => {
          const result = await getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
          const asset = result.assets?.[0];
          if (!result.canceled && asset) await sendFile(asset.uri, asset.name);
        }); }} style={styles.action}>
        <Text style={{ color: colors.text, opacity: disabled || working ? 0.4 : 1 }}>Send audio file</Text>
      </Pressable>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 8 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  primary: { minHeight: 48, justifyContent: 'center', borderRadius: 16, paddingHorizontal: 18 },
  action: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14 },
});
