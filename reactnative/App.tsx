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
import { SettingsScreen } from "./src/chat/SettingsScreen";

export default function App() {
  const dark = useColorScheme() === "dark";
  const colors = palettes[dark ? "dark" : "light"];
  const {
    history,
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
    <QueryClientProvider client={queryClient}>
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
          settings={model.settings}
          onSendAudio={sendAudio}
          onStop={() => {
            void stop();
          }}
          onRetryReply={(id) => {
            void retryReply(id, model.settings);
          }}
          onOpenSettings={() => {
            if (model.ready)
              void flushDraft().then((saved) => {
                if (saved) setSettingsOpen(true);
              });
          }}
          draft={draft}
          onSend={(text) => send(text, model.settings)}
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
    </QueryClientProvider>
  );
}
