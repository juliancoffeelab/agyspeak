import { useCallback, useState, type ReactNode } from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";

import { ChatBody, ChatLayout } from "./ChatLayout";
import { ComposerRegion } from "./Composer";
import { OpenFailure } from "./OpenFailure";
import {
  useOpenChatScope,
  useOpenChatModelName,
  useOpenChatState,
} from "./chatContext";
import { useColors } from "../../ui/theme";
import { screenStyles } from "../../ui/screenStyles";
import type { PhotoReference } from "./storage/contracts";

// The chat destination: one layout, mounted from the first frame, whose
// header, conversation and composer regions fill in place. `status` fills
// the conversation region until the chats are open. The coordinator owns
// which chat is shown; this screen only asks it to open another.
export function ChatEntry({ status }: { status: ReactNode }) {
  const router = useRouter();
  const focused = useIsFocused();
  // The new chat is the one with no messages yet.
  const inNewChat = useOpenChatState(
    (state) => state.history.messages.length === 0,
    true,
  );
  const saving = useOpenChatState((state) => state.saving, false);
  const modelName = useOpenChatModelName();
  const failure = useOpenChatState((state) => state.openFailure, null);
  const commands = useOpenChatScope()?.chat ?? null;
  const ready = commands !== null;
  const open = useCallback(
    (id: string | null) => void commands?.select(id),
    [commands],
  );
  const onOpenSettings = () => router.push("/settings");

  // Back from a saved chat opens the new chat on this same screen; Back
  // from the new chat leaves the app as usual.
  const backToNew = ready && !inNewChat;
  useFocusEffect(
    useCallback(() => {
      if (!backToNew) return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          open(null);
          return true;
        },
      );
      return () => subscription.remove();
    }, [backToNew, open]),
  );

  // What the open chat shows over its layout, closed whenever it doesn't.
  const [choosingModel, setChoosingModel] = useState(false);
  const [photo, setPhoto] = useState<PhotoReference | null>(null);
  const closePhoto = useCallback(() => setPhoto(null), []);
  const [scrollRequest, setScrollRequest] = useState(0);
  if (!ready && (choosingModel || photo !== null)) {
    setChoosingModel(false);
    setPhoto(null);
  }

  return (
    <ChatLayout
      modelSelector={{
        label: modelName,
        disabled: !ready || saving,
        onPress: () => {
          Keyboard.dismiss();
          setChoosingModel(true);
        },
      }}
      newChatDisabled={!ready || saving || inNewChat}
      navigationDisabled={saving}
      onNewChat={() => open(null)}
      onOpenHistory={() => router.push("/history")}
      onOpenSettings={onOpenSettings}
    >
      <View style={styles.screen}>
        {!ready ? (
          <View style={styles.status}>{status}</View>
        ) : failure ? (
          <OpenFailure
            error={failure.error}
            onRetry={() => open(failure.id)}
            onDismiss={() => commands.dismissError()}
          />
        ) : (
          <ChatBody
            focused={focused}
            choosingModel={choosingModel}
            onCloseModel={() => setChoosingModel(false)}
            photo={photo}
            onOpenPhoto={setPhoto}
            onClosePhoto={closePhoto}
            scrollRequest={scrollRequest}
            onOpenSettings={onOpenSettings}
          />
        )}
      </View>
      <ComposerRegion
        ready={ready}
        active={focused && !choosingModel}
        onOpenPhoto={setPhoto}
        onSent={() => setScrollRequest((value) => value + 1)}
      />
    </ChatLayout>
  );
}

// A route that names no destination, such as a malformed link.
export function UnknownRoute() {
  const router = useRouter();
  const colors = useColors();
  return (
    <ChatLayout
      modelSelector={null}
      newChatDisabled
      navigationDisabled={false}
      onNewChat={() => {}}
      onOpenHistory={() => router.push("/history")}
      onOpenSettings={() => router.push("/settings")}
    >
      <View style={[styles.screen, styles.empty, styles.unknown]}>
        <Text
          accessibilityRole="alert"
          style={[styles.emptyTitle, { color: colors.text }]}
        >
          This link isn’t valid.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace("/")}
          style={styles.action}
        >
          <Text style={[styles.actionText, { color: colors.text }]}>
            Open chat
          </Text>
        </Pressable>
      </View>
      <ComposerRegion
        ready={false}
        active={false}
        onOpenPhoto={() => {}}
        onSent={() => {}}
      />
    </ChatLayout>
  );
}

const styles = StyleSheet.create({
  ...screenStyles,
  unknown: { paddingHorizontal: 20 },
  status: { padding: 20 },
  action: { minHeight: 48, justifyContent: "center", marginTop: 12 },
  actionText: { fontSize: 15, fontWeight: "600" },
});
