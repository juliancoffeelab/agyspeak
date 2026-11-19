import { useEffect } from "react";
import { AppState } from "react-native";
import { useChatScope } from "./chatContext";

export function useReplySpeech(active: boolean, chatId: string) {
  const { speech: replySpeech } = useChatScope();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void replySpeech.stop();
    });
    return () => {
      subscription.remove();
      void replySpeech.stop();
    };
  }, [replySpeech]);
  useEffect(() => {
    if (!active) void replySpeech.stop();
    return () => {
      void replySpeech.stop();
    };
  }, [replySpeech, active, chatId]);
}
