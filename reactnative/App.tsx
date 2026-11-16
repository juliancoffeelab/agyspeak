import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./src/chat/queryClient";
import { StatusBar } from "expo-status-bar";
import { Alert, Keyboard, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { SavedChat } from "./src/chat/history";
import { useChatHistory } from "./src/chat/useChatHistory";
import { ChatScreen } from "./src/chat/ChatScreen";
import { HistoryScreen } from "./src/chat/HistoryScreen";
import { palettes } from "./src/chat/theme";
import { useModelSettings } from "./src/chat/useModelSettings";
import { useModelCatalog } from "./src/chat/useRouterMetadata";
import { audioInputIssue, imageInputIssue } from "./src/chat/audioCapability";
import { SettingsScreen } from "./src/chat/SettingsScreen";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatApp />
    </QueryClientProvider>
  );
}

function ChatApp() {
  const dark = useColorScheme() === "dark";
  const colors = palettes[dark ? "dark" : "light"];
  const {
    history,
    readPhoto,
    chooseModel,
    draft,
    flushDraft,
    busy,
    pending,
    error,
    retry,
    send,
    sendAudio,
    retryReply,
    stop,
    select,
    remove,
  } = useChatHistory();
  const model = useModelSettings();
  const catalog = useModelCatalog();
  const chatSettings = {
    ...model.settings,
    model: history?.selectedModel ?? model.settings.model,
  };
  const audioIssue = audioInputIssue(chatSettings.model, catalog.models);
  const imageIssue = imageInputIssue(chatSettings.model, catalog.models);
  const selectedModelName =
    catalog.models.find((item) => item.id === chatSettings.model)?.name ??
    chatSettings.model;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  async function openChat(id: string | null) {
    if (await select(id)) {
      Keyboard.dismiss();
      setHistoryOpen(false);
    }
  }

  function deleteChat(chat: SavedChat) {
    Alert.alert(
      "Delete chat?",
      `“${chat.title}” will be permanently deleted from this phone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void remove(chat.id);
          },
        },
      ],
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? "light" : "dark"} />
      <ChatScreen
        colors={colors}
        visible={!historyOpen && !settingsOpen}
        history={history}
        busy={busy}
        error={error ?? model.error}
        pending={pending}
        connected={model.ready && Boolean(model.settings.apiKey)}
        settings={chatSettings}
        audioIssue={audioIssue}
        imageIssue={imageIssue}
        onSendAudio={sendAudio}
        onReadPhoto={readPhoto}
        modelName={selectedModelName}
        onChooseModel={chooseModel}
        onStop={() => {
          void stop();
        }}
        onRetryReply={(id) => {
          void retryReply(id, chatSettings);
        }}
        onOpenSettings={() => {
          if (model.ready)
            void flushDraft().then((saved) => {
              if (saved) setSettingsOpen(true);
            });
        }}
        draft={draft}
        onSend={(text, photos) => send(text, chatSettings, photos)}
        onNewChat={() => {
          void openChat(null);
        }}
        onOpenHistory={() => {
          void flushDraft().then((saved) => {
            if (saved) setHistoryOpen(true);
          });
        }}
        onRetry={retry}
      />
      <HistoryScreen
        visible={historyOpen && !settingsOpen}
        colors={colors}
        chats={history?.chats ?? []}
        activeId={history?.activeId ?? null}
        busy={busy}
        error={error}
        onClose={() => setHistoryOpen(false)}
        onOpen={(id) => {
          void openChat(id);
        }}
        onDelete={deleteChat}
        onSettings={() => {
          if (model.ready)
            void flushDraft().then((saved) => {
              if (saved) setSettingsOpen(true);
            });
        }}
      />
      {settingsOpen && model.ready && (
        <SettingsScreen
          colors={colors}
          initial={model.settings}
          onSaveKey={model.saveKey}
          onSaveModel={model.saveModel}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </SafeAreaProvider>
  );
}
