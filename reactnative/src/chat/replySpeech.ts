import { Alert } from "react-native";
import * as Speech from "expo-speech";
import { PromiseSpeech } from "./PromiseSpeech";
import { queryClient } from "./queryClient";
import { speechVoicesQuery } from "./speechVoices";
import {
  speechLanguageLabel,
  voiceForLanguage,
  type SpeechLanguage,
} from "./speechLanguage";
import { SpeechUnavailableError, SpeechSession } from "./SpeechSession";

async function prepareVoice(language?: SpeechLanguage) {
  // Discover voices before enqueueing: Android's pre-initialization utterance
  // queue cannot be cleared by Stop. The picker and playback share this cache.
  const voices = await queryClient.query(speechVoicesQuery);
  if (!language) return {};
  const voice = voiceForLanguage(language, voices);
  if (!voice) {
    void queryClient.invalidateQueries({
      queryKey: speechVoicesQuery.queryKey,
      refetchType: "none",
    });
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
      ...selection,
      // Expo Android passes language to Locale.Builder.setLanguage(), which needs
      // a base code; the explicit voice identifier preserves the chosen region.
      language: selection?.language?.split("-")[0],
      rate: 1,
      pitch: 1,
    }),
});
export const replySpeech = new SpeechSession({
  prepare: prepareVoice,
  stop: playback.stop,
  speak: playback.speak,
  onError: (message) => Alert.alert("Read aloud", message),
});
