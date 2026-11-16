import { useEffect } from "react";
import { AppState } from "react-native";
import { replySpeech } from "./replySpeech";

export function useReplySpeech(
  visible: boolean,
  chatId: string | null | undefined,
) {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void replySpeech.stop();
    });
    return () => {
      subscription.remove();
      void replySpeech.stop();
    };
  }, []);
  useEffect(() => {
    if (!visible) void replySpeech.stop();
    return () => {
      void replySpeech.stop();
    };
  }, [visible, chatId]);
}
