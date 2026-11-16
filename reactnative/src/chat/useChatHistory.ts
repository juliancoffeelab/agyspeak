import { useEffect, useRef, useState } from "react";
import { fetch as streamingFetch } from "expo/fetch";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";

import { audioInputIssue, imageInputIssue } from "./audioCapability";
import { queryClient } from "./queryClient";
import { MODEL_CATALOG_KEY } from "./routerQueries";
import type { RouterModel } from "./routerMetadata";
import { ChatController, type ChatState } from "./ChatController";
import {
  HistoryStore,
  type AudioInput,
  type PhotoReference,
  type PhotoInput,
} from "./history";
import { completeReply, type ModelSettings } from "./openRouter";

export function useChatHistory() {
  const controllerRef = useRef<ChatController | null>(null);
  const [state, setState] = useState<ChatState | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    let appStateSubscription: { remove: () => void } | undefined;
    let unsubscribe: (() => void) | undefined;
    const opening = (async () => {
      const { openDatabaseAsync } = await import("expo-sqlite");
      const db = await openDatabaseAsync("chat-history.db", {
        useNewConnection: true,
      });
      try {
        const store = new HistoryStore(db);
        await store.initialize();
        const history = await store.read();
        const initialDraft = await store.readDraft(history.activeId);
        const initialPhotos = await store.readPhotoDraft(history.activeId);
        const controller = new ChatController(
          store,
          history,
          (messages, settings, signal, onText) =>
            completeReply(messages, settings, signal, onText, streamingFetch),
          randomUUID,
          initialDraft,
          (model) =>
            audioInputIssue(
              model,
              queryClient.getQueryData<RouterModel[]>(MODEL_CATALOG_KEY),
            ),
          (model) =>
            imageInputIssue(
              model,
              queryClient.getQueryData<RouterModel[]>(MODEL_CATALOG_KEY),
            ),
          initialPhotos,
        );
        if (mounted) {
          controllerRef.current = controller;
          appStateSubscription = AppState.addEventListener(
            "change",
            (status) => {
              if (status !== "active") void controller.flushDraft();
            },
          );
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
      appStateSubscription?.remove();
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
    chooseModel: (model: string) =>
      controllerRef.current?.chooseModel(model) ?? Promise.resolve(false),
    readPhoto: (reference: PhotoReference) =>
      controllerRef.current?.readPhoto(reference) ??
      Promise.reject(new Error("Chat storage is not ready.")),
    history: state?.history ?? null,
    draft: state?.draft ?? null,
    flushDraft: () =>
      controllerRef.current?.flushDraft() ?? Promise.resolve(false),
    busy: state?.saving ?? false,
    pending: state?.pending ?? null,
    error: openError ?? state?.error ?? null,
    retry: () => {
      setOpenError(null);
      setAttempt((value) => value + 1);
    },
    send: (text: string, settings: ModelSettings, photos?: PhotoInput[]) =>
      controllerRef.current?.send(text, settings, photos) ??
      Promise.resolve(false),
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
