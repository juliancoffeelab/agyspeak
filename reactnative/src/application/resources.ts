import type { QueryClient } from "@tanstack/react-query";
import { fetch as streamingFetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Alert, AppState } from "react-native";

import {
  audioInputIssue,
  imageInputIssue,
} from "../features/chat/runtime/capability";
import { ChatCoordinator } from "../features/chat/runtime/coordinator";
import { ChatRepository } from "../features/chat/storage/repository";
import { orderedDatabase, type OrderedDatabase } from "../storage/database";
import { createAudioArbiter, type AudioArbiter } from "../device/audio";
import { createDeviceSpeech } from "../device/speech/deviceSpeech";
import {
  createResponseSpeech,
  type ResponseSpeech,
} from "../features/chat/runtime/responseSpeech";
import type { SpeechSession } from "../device/speech/SpeechSession";
import { speechVoicesQuery } from "../device/speech/voices";
import {
  createOpenRouterConnection,
  type OpenRouterConnection,
} from "../connections/openrouter";
import {
  createPreferences,
  readPreferences,
  type PreferencesOwner,
} from "../preferences/preferences";
import {
  replyTokenLimit,
  type RouterModel,
} from "../providers/openrouter/metadata";
import {
  discardUsage,
  MODEL_CATALOG_KEY,
  modelCatalogQuery,
  routerUsageQuery,
} from "../providers/openrouter/queries";
import { catalogStorage } from "../providers/openrouter/catalogFile";
import { completeReply } from "../providers/openrouter/transport";
import { openHistory } from "../storage/historyMigration";
import { systemLanguage } from "../device/locale";

export type AppResources = {
  connection: OpenRouterConnection;
  preferences: PreferencesOwner;
  chat: ChatCoordinator;
  audio: AudioArbiter;
  speech: SpeechSession;
  responseSpeech: ResponseSpeech;
};
// What Settings needs, open before the chat is hydrated.
export type CoreResources = Pick<AppResources, "connection" | "preferences">;

const secure = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
};

// Construct every app resource once. `onCore` receives the connection, whose
// key may still be reading, and the preferences as soon as the history
// database is migrated and they are read, before the chat is hydrated. The
// returned dispose stops work, flushes drafts and closes storage in order. A failure retires the connection and closes
// storage before rejecting, so a retry starts only after accepted saves are
// durable.
export async function openResources(
  queryClient: QueryClient,
  onCore: (core: CoreResources) => void,
) {
  // The database a failure must close, once it is open.
  let opened: OrderedDatabase | null = null;
  // The key is read while the database opens; only credential actions wait
  // for it.
  const connection = createOpenRouterConnection(secure);
  try {
    const { openDatabaseAsync } = await import("expo-sqlite");
    const native = await openDatabaseAsync("chat-history.db", {
      useNewConnection: true,
    });
    const db = orderedDatabase(native);
    opened = db;
    // Runs before any other storage access. The copy made before an upgrade
    // replaces the one the previous upgrade left.
    const backup = `${native.databasePath}.before-upgrade`;
    await db.run((database) =>
      openHistory(database, { systemLanguage: systemLanguage() }, () => {
        const previous = new File(`file://${backup}`);
        if (previous.exists) previous.delete();
        return backup;
      }),
    );
    const preferences = createPreferences(db, await readPreferences(db));
    onCore({ connection, preferences });
    // Warm predictable metadata in the background through the queries its
    // consumers use; they show any failure and retry it.
    queryClient
      .query(modelCatalogQuery(catalogStorage, fetch))
      .catch(() => undefined);
    void connection.read().then(() => {
      const credential = connection.capture();
      if (credential)
        queryClient
          .query(routerUsageQuery(credential, fetch))
          .catch(() => undefined);
    });
    const store = new ChatRepository(db, randomUUID);
    await store.initialize();
    const catalog = () =>
      queryClient.getQueryData<RouterModel[]>(MODEL_CATALOG_KEY);
    const controller = new ChatCoordinator({
      store,
      newChat: await store.readNewChat(),
      reply: (messages, request, signal, onText) =>
        completeReply(
          messages,
          {
            ...request,
            maxTokens: replyTokenLimit(request.model, catalog()),
          },
          signal,
          onText,
          streamingFetch,
        ),
      settings: () => ({
        apiKey: connection.capture()?.apiKey ?? null,
        model: preferences.state.getState().defaultModel,
      }),
      audioIssue: (model) => audioInputIssue(model, catalog()),
      imageIssue: (model) => imageInputIssue(model, catalog()),
      now: () => performance.now(),
    });
    // The saved chats are listed after the new chat opens; History shows
    // their loading or failure.
    void controller.loadChats();
    const audio = createAudioArbiter();
    const speech = createDeviceSpeech({
      audio,
      voices: () => queryClient.query(speechVoicesQuery),
      forgetVoices: () =>
        void queryClient.invalidateQueries({
          queryKey: speechVoicesQuery.queryKey,
          refetchType: "none",
        }),
      onError: (message) => Alert.alert("Read aloud", message),
    });
    const responseSpeech = createResponseSpeech({
      speech,
      defaultLanguage: () => preferences.state.getState().speechLanguage,
      onError: (message) => Alert.alert("Read aloud", message),
    });
    queryClient.query(speechVoicesQuery).catch(() => undefined);
    const resources: AppResources = {
      connection,
      preferences,
      chat: controller,
      audio,
      speech,
      responseSpeech,
    };
    const background = AppState.addEventListener("change", (status) => {
      if (status !== "active") void controller.flushDraft();
    });
    // Usage cached for a replaced credential is never shown again.
    const replacedKey = connection.state.subscribe(({ revision }) =>
      discardUsage(queryClient, connection.lifetime, revision),
    );
    return {
      resources,
      async dispose() {
        background.remove();
        replacedKey();
        await speech.stop();
        try {
          await connection.retire();
          await controller.dispose();
        } finally {
          discardUsage(queryClient, connection.lifetime, null);
          await db.close();
        }
      },
    };
  } catch (cause) {
    // The connection refuses later saves at once and settles the accepted
    // ones; closing storage does the same for everything in the database.
    await connection.retire();
    discardUsage(queryClient, connection.lifetime, null);
    await opened?.close();
    throw cause;
  }
}
