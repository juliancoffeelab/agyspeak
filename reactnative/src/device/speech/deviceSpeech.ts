import * as Speech from "expo-speech";

import type { AudioArbiter } from "../audio.ts";
import {
  speechLanguageLabel,
  voiceForLanguage,
  type SpeechLanguage,
  type SpeechSelection,
} from "./language";
import { PromiseSpeech } from "./PromiseSpeech";
import { SpeechSession, SpeechUnavailableError } from "./SpeechSession";

type DeviceSpeechPorts = {
  audio: AudioArbiter;
  // Shared with the language picker: one discovery cache for both.
  voices: () => Promise<Speech.Voice[]>;
  // Marks the cache stale after a voice turns out to be missing.
  forgetVoices: () => void;
  onError: (message: string) => void;
};

// Read-aloud on the device’s TTS engine, constructed by the app scope.
export function createDeviceSpeech(ports: DeviceSpeechPorts) {
  async function prepare(
    language: SpeechLanguage | null,
  ): Promise<SpeechSelection> {
    // Discover voices before enqueueing: Android's pre-initialization utterance
    // queue cannot be cleared by Stop.
    const voices = await ports.voices();
    if (language === null) return null;
    const voice = voiceForLanguage(language, voices);
    if (!voice) {
      ports.forgetVoices();
      throw new SpeechUnavailableError(
        `No ${speechLanguageLabel(language)} voice is available in the selected TTS engine. Add that language in the phone’s text-to-speech settings.`,
      );
    }
    return { language, voice: voice.identifier };
  }
  const playback = new PromiseSpeech({
    maxLength: Speech.maxSpeechInputLength,
    stop: () => Speech.stop(),
    speak: (prose, selection, callbacks) =>
      Speech.speak(prose, {
        ...callbacks,
        // Expo Android passes language to Locale.Builder.setLanguage(), which
        // needs a base code; the explicit voice identifier keeps the region.
        ...(selection && {
          voice: selection.voice,
          language: selection.language.split("-")[0],
        }),
        rate: 1,
        pitch: 1,
      }),
  });
  return new SpeechSession({
    prepare,
    stop: playback.stop,
    speak: playback.speak,
    onError: ports.onError,
    audio: ports.audio,
  });
}
