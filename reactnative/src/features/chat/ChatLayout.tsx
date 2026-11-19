import type { ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import X from "lucide-react-native/icons/x";

import { Conversation } from "./Conversation";
import { PhotoViewer } from "./PhotoViewer";
import { useReplySpeech } from "./useReplySpeech";
import { useStore } from "zustand";
import { useChatScope, useChatModel, useChatState } from "./chatContext";
import type { PhotoReference } from "./storage/contracts";
import { Failure } from "../../ui/Failure";
import { ChatHeader } from "../../ui/ChatHeader";
import { ModelPicker } from "../../ui/ModelPicker";
import { useColors } from "../../ui/theme";
import { useKeyboardVisible } from "../../ui/useKeyboardVisible";
import { screenStyles } from "../../ui/screenStyles";

type ChatNavigation = {
  onNewChat: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
};

// The open chat's conversation region: its messages, notices and the
// pickers it opens. The layout and composer frame around it stay mounted.
export function ChatBody({
  focused,
  choosingModel,
  onCloseModel,
  photo,
  onOpenPhoto,
  onClosePhoto,
  scrollRequest,
  onOpenSettings,
}: {
  focused: boolean;
  choosingModel: boolean;
  onCloseModel: () => void;
  photo: PhotoReference | null;
  onOpenPhoto: (reference: PhotoReference) => void;
  onClosePhoto: () => void;
  scrollRequest: number;
  onOpenSettings: () => void;
}) {
  const colors = useColors();
  const { chat: commands, connection } = useChatScope();
  const activeId = useChatState((state) => state.history.activeId);
  const error = useChatState((state) => state.error);
  const key = useStore(connection.state);
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
        <View
          style={[
            styles.toast,
            { borderColor: colors.line, backgroundColor: colors.surface },
          ]}
        >
          <Text
            accessibilityRole="alert"
            style={[styles.error, styles.toastText, { color: colors.text }]}
          >
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss message"
            onPress={() => commands.dismissError()}
            style={styles.dismiss}
          >
            <X size={20} color={colors.muted} />
          </Pressable>
        </View>
      )}
      <Conversation
        key={activeId}
        scrollRequest={scrollRequest}
        onOpenPhoto={onOpenPhoto}
      />
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

// The one chat destination layout, from its first frame: the header, then
// the conversation and composer regions in `children`.
export function ChatLayout({
  modelSelector,
  newChatDisabled,
  navigationDisabled,
  onNewChat,
  onOpenHistory,
  onOpenSettings,
  children,
}: ChatNavigation & {
  modelSelector: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  } | null;
  newChatDisabled: boolean;
  navigationDisabled: boolean;
  children: ReactNode;
}) {
  const colors = useColors();
  const keyboardVisible = useKeyboardVisible();
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <SafeAreaView
        style={styles.screen}
        edges={keyboardVisible ? ["top", "left", "right"] : undefined}
      >
        <ChatHeader
          modelSelector={modelSelector}
          mode="chat"
          newChatDisabled={newChatDisabled}
          navigationDisabled={navigationDisabled}
          onNewChat={() => {
            Keyboard.dismiss();
            onNewChat();
          }}
          onNavigate={() => {
            Keyboard.dismiss();
            onOpenHistory();
          }}
          onSettings={() => {
            Keyboard.dismiss();
            onOpenSettings();
          }}
        />
        {children}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  ...screenStyles,
  connect: { minHeight: 48, justifyContent: "center", paddingHorizontal: 20 },
  connectText: { fontSize: 14, fontWeight: "500" },
  keyFailure: { paddingHorizontal: 20, paddingVertical: 12 },
  // Floats over the top of the conversation instead of moving it.
  toast: {
    position: "absolute",
    top: 8,
    left: 12,
    right: 12,
    zIndex: 1,
    elevation: 3,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  toastText: { flex: 1 },
  dismiss: {
    minHeight: 48,
    minWidth: 48,
    alignItems: "center",
    justifyContent: "center",
  },
});
