import { createStore } from "zustand/vanilla";

import type { SpeechLanguage } from "../../../device/speech/language";
import type { SpeechSession } from "../../../device/speech/SpeechSession";
import { markdownToSpeechText } from "./speechText.ts";

type ResponseSpeechPorts = {
  speech: SpeechSession;
  // The saved default, read when reading starts; a response's choice wins.
  defaultLanguage: () => SpeechLanguage | null;
  onError: (message: string) => void;
};

// Reading responses aloud: what is spoken and in which language. Playback
// itself is the device session's; a response is keyed by its chat and place.
export function createResponseSpeech(ports: ResponseSpeechPorts) {
  const languages = createStore<ReadonlyMap<string, SpeechLanguage>>()(
    () => new Map(),
  );
  return {
    languages,
    toggle(messageId: string, markdown: string) {
      const { speech } = ports;
      if (speech.getSnapshot().playing === messageId) return speech.stop();
      const prose = markdownToSpeechText(markdown);
      if (!prose) {
        ports.onError("There’s no spoken text in this response.");
        return Promise.resolve();
      }
      return speech.play(
        messageId,
        prose,
        languages.getState().get(messageId) ?? ports.defaultLanguage(),
      );
    },
    // A new choice applies from the next reading; the current one stops.
    // Null returns the response to the saved default.
    setLanguage(messageId: string, language: SpeechLanguage | null) {
      const next = new Map(languages.getState());
      if (language !== null) next.set(messageId, language);
      else next.delete(messageId);
      languages.setState(next, true);
      if (ports.speech.getSnapshot().playing === messageId)
        void ports.speech.stop();
    },
  };
}
export type ResponseSpeech = ReturnType<typeof createResponseSpeech>;
