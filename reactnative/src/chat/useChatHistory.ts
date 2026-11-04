import { useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";

import { ChatController, type ChatState } from "./ChatController";
import { HistoryStore, type AudioInput } from "./history";
import { completeReply, type ModelSettings } from "./openRouter";

export function useChatHistory() {
  const controllerRef = useRef<ChatController | null>(null);
  const [state, setState] = useState<ChatState | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    const opening = (async () => {
      const { openDatabaseAsync } = await import("expo-sqlite");
      const db = await openDatabaseAsync("chat-history.db", {
        useNewConnection: true,
      });
      try {
        const store = new HistoryStore(db);
        await store.initialize();
        const controller = new ChatController(
          store,
          await store.read(),
          completeReply,
          randomUUID,
        );
        if (mounted) {
          controllerRef.current = controller;
          setState(controller.getSnapshot());
          setOpenError(null);
          unsubscribe = controller.subscribe(() =>
            setState(controller.getSnapshot()),
          );
        }
        return { controller, db };
      } catch (cause) {
        await db.closeAsync();
        throw cause;
      }
    })();
    void opening.catch((cause) => {
      console.error("Could not open chat history", cause);
      if (mounted)
        setOpenError("Couldn’t open chat history. Please try again.");
    });
    return () => {
      mounted = false;
      unsubscribe?.();
      controllerRef.current = null;
      void opening
        .then(async ({ controller, db }) => {
          await controller.dispose();
          await db.closeAsync();
        })
        .catch(() => {});
    };
  }, [attempt]);

  return {
    history: state?.history ?? null,
    busy: state?.saving ?? false,
    pending: state?.pending ?? null,
    error: openError ?? state?.error ?? null,
    retry: () => {
      setOpenError(null);
      setAttempt((value) => value + 1);
    },
    send: (text: string, settings: ModelSettings) =>
      controllerRef.current?.send(text, settings) ?? Promise.resolve(false),
    sendAudio: (audio: AudioInput, settings: ModelSettings) =>
      controllerRef.current?.sendAudio(audio, settings) ??
      Promise.resolve(false),
    retryReply: (id: number, settings: ModelSettings) =>
      controllerRef.current?.retryReply(id, settings) ?? Promise.resolve(false),
    stop: () => controllerRef.current?.stop() ?? Promise.resolve(),
    select: (id: string | null) =>
      controllerRef.current?.select(id) ?? Promise.resolve(false),
    remove: (id: string) =>
      controllerRef.current?.remove(id) ?? Promise.resolve(false),
  };
}
