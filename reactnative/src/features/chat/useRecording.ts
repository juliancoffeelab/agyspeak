import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import {
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";

import { useChatScope } from "./chatContext";
import { removeFile } from "../../device/files";
import type { AudioInput } from "./storage/contracts";
import {
  AUDIO_FORMATS,
  MAX_AUDIO_BYTES,
  megabytes,
} from "../../providers/openrouter/transport";
import {
  RecordingSession,
  type RecordingClip,
} from "../../device/recording/RecordingSession";

export function useRecording(
  active: boolean,
  submit: (audio: AudioInput) => Promise<boolean>,
) {
  const { speech: replySpeech, audio } = useChatScope();
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const session = useMemo(
    () =>
      new RecordingSession({
        permission: async () =>
          (await getRecordingPermissionsAsync()).granted ||
          (await requestRecordingPermissionsAsync()).granted,
        prepare: async () => {
          if (!(await replySpeech.stop()))
            throw new Error("Couldn’t stop read-aloud before recording.");
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
          });
          await recorder.prepareToRecordAsync();
        },
        record: () => recorder.record({ forDuration: 120 }),
        stop: async () => {
          try {
            await recorder.stop();
          } finally {
            await setAudioModeAsync({
              allowsRecording: false,
              playsInSilentMode: true,
            });
          }
        },
        status: () => recorder.getStatus(),
        uri: () => recorder.uri,
        remove: removeFile,
        audio,
      }),
    [recorder, replySpeech, audio],
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    session.setActive(active && AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (next) =>
      session.setActive(active && next === "active"),
    );
    return () => {
      listener.remove();
      session.setActive(false);
    };
  }, [session, active]);
  useEffect(
    () => () => {
      session.setActive(false);
      void session.discard();
    },
    [session],
  );
  useEffect(() => {
    if (state.phase !== "recording") return;
    const timer = setInterval(() => session.sample(), 150);
    return () => clearInterval(timer);
  }, [session, state.phase]);

  function send() {
    return session.send(async (clip, signal) => {
      const file = new File(clip.uri);
      if (!file.exists || !file.size || file.size > MAX_AUDIO_BYTES)
        throw new Error(
          `Choose a nonempty audio file under ${megabytes(MAX_AUDIO_BYTES)}.`,
        );
      const data = await file.base64();
      if (signal.aborted) return false;
      return submit({
        data,
        format: clip.format,
        durationMillis: clip.durationMillis,
        levels: clip.levels,
      });
    });
  }
  async function attach() {
    const selected = await session.pick(
      async (): Promise<RecordingClip | null> => {
        const result = await getDocumentAsync({
          type: "audio/*",
          copyToCacheDirectory: true,
          multiple: false,
        });
        const asset = result.assets?.[0];
        if (result.canceled || !asset) return null;
        const format = asset.name.split(".").at(-1)?.toLowerCase() ?? "";
        const file = new File(asset.uri);
        if (
          !AUDIO_FORMATS.includes(format) ||
          !file.size ||
          file.size > MAX_AUDIO_BYTES
        ) {
          removeFile(asset.uri);
          throw new Error(
            `Choose a supported audio file under ${megabytes(MAX_AUDIO_BYTES)}.`,
          );
        }
        return { uri: asset.uri, format };
      },
    );
    if (selected) await send();
  }
  return {
    state,
    start: () => session.start(),
    discard: () => session.discard(),
    send,
    attach,
  };
}
