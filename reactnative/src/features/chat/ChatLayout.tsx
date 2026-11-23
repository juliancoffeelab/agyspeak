import type { ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";

import { Conversation } from "./Conversation";
import { PhotoViewer } from "./PhotoViewer";
import { useReplySpeech } from "./useReplySpeech";
import { useStore } from "zustand";
import {
  useChatScope,
  useChatModel,
  useChatState,
  useOpenChat,
} from "./chatContext";
import type { PhotoReference } from "./storage/contracts";
import { Failure } from "../../ui/Failure";
import { ChatHeader } from "../../ui/ChatHeader";
import { ModelPicker } from "../../ui/ModelPicker";
import { useColors } from "../../ui/theme";
import { KeyboardDock, Screen } from "../../ui/Screen";
import { Toast } from "../../ui/Toast";
import { screenStyles } from "../../ui/screenStyles";

type ChatNavigation = {
  onNewChat: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
};

// The open chat's conversation region: its messages and what it opens over
// them. The layout and composer frame around it stay mounted.
export function ChatBody({
  focused,
  choosingModel,
  onCloseModel,
  photo,
  onOpenPhoto,
  onClosePhoto,
  scrollRequest,
}: {
  focused: boolean;
  choosingModel: boolean;
  onCloseModel: () => void;
  photo: PhotoReference | null;
  onOpenPhoto: (reference: PhotoReference) => void;
  onClosePhoto: () => void;
  scrollRequest: number;
}) {
  const { chat: commands } = useChatScope();
  const activeId = useOpenChat((view) => view.id);
  const error = useChatState((state) => state.error);
  const model = useChatModel();
  useReplySpeech(focused && !choosingModel, activeId);

  return (
    <>
      {photo !== null && (
        <PhotoViewer
          reference={photo}
          load={(photo) => commands.readPhoto(photo)}
          onClose={onClosePhoto}
        />
      )}
      {choosingModel && focused && (
        <ModelPicker
          title="Model"
          selected={model.model}
          onSelect={(model) => commands.chooseModel(model)}
          onClose={onCloseModel}
        />
      )}
      {error !== null && (
        <Toast message={error} onDismiss={() => commands.dismissError()} />
      )}
      <Conversation
        key={activeId}
        scrollRequest={scrollRequest}
        onOpenPhoto={onOpenPhoto}
      />
    </>
  );
}

// What stands between the open chat and sending: the saved key couldn't be
// read, or there is none. Docked with the composer, so that it takes no room
// from the conversation when it appears.
export function ChatNotices({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const colors = useColors();
  const { connection } = useChatScope();
  const key = useStore(connection.state);
  return (
    <>
      {key.status === "failed" && (
        <View style={styles.keyFailure}>
          <Failure
            message="Couldn’t read the saved OpenRouter key."
            hint={null}
            error={key.failure}
            onRetry={() => void connection.reload()}
            onDismiss={null}
          />
        </View>
      )}
      {key.status === "ready" && !key.connected && (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenSettings}
          style={styles.connect}
        >
          <Text style={[styles.connectText, { color: colors.text }]}>
            Connect OpenRouter
          </Text>
        </Pressable>
      )}
    </>
  );
}

// The one chat destination layout, from its first frame: the header, the
// conversation region in `children`, and `dock` over its bottom edge.
export function ChatLayout({
  modelSelector,
  newChatDisabled,
  navigationDisabled,
  onNewChat,
  onOpenHistory,
  onOpenSettings,
  dock,
  children,
}: ChatNavigation & {
  modelSelector: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  } | null;
  newChatDisabled: boolean;
  navigationDisabled: boolean;
  dock: ReactNode;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <Screen keyboard="dock" background={colors.background}>
      <ChatHeader
        modelSelector={modelSelector}
        mode="chat"
        newChatDisabled={newChatDisabled}
        navigationDisabled={navigationDisabled}
        onNewChat={() => {
          Keyboard.dismiss();
          onNewChat();
        }}
        onNavigate={onOpenHistory}
        onSettings={onOpenSettings}
      />
      <View style={styles.screen}>
        {children}
        <KeyboardDock>{dock}</KeyboardDock>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  ...screenStyles,
  connect: { minHeight: 48, justifyContent: "center", paddingHorizontal: 20 },
  connectText: { fontSize: 14, fontWeight: "500" },
  keyFailure: { paddingHorizontal: 20, paddingVertical: 12 },
});
