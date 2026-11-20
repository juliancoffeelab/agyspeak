import { useCallback, useState, type ReactNode } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";

import { ChatBody, ChatLayout, ChatNotices } from "./ChatLayout";
import { ComposerRegion } from "./Composer";
import { History } from "./History";
import { OpenFailure } from "./OpenFailure";
import {
  useOpenChatScope,
  useOpenChatModelName,
  useOpenChatState,
} from "./chatContext";
import { AboveDock } from "../../ui/Screen";
import { SideDrawer } from "../../ui/SideDrawer";
import { useColors } from "../../ui/theme";
import { screenStyles } from "../../ui/screenStyles";
import type { PhotoReference } from "./storage/contracts";

// The chat destination: one layout, mounted from the first frame, whose
// header, conversation and composer regions fill in place, with History in
// a drawer beside it. `status` fills the conversation region, and History's
// list, until the chats are open. The coordinator owns which chat is shown;
// this screen only asks it to open another.
export function ChatEntry({ status }: { status: ReactNode }) {
  const router = useRouter();
  const [historyOpen, setHistoryOpen] = useState(false);
  // The chat is in use while its route is focused and History is closed.
  const focused = useIsFocused() && !historyOpen;
  const activeId = useOpenChatState((state) => state.history.activeId, null);
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

  // The chat History last opened, until Back has returned from it.
  const [fromHistory, setFromHistory] = useState<string | null>(null);
  const openFromHistory = (id: string | null) => {
    if (id !== activeId) open(id);
    setFromHistory(id);
    setHistoryOpen(false);
  };

  // Back closes History, keeping the chat beside it. Back from a chat that
  // History opened returns to History once; from any other saved chat it
  // opens the new chat, and from the new chat it leaves the app as usual.
  const back = historyOpen
    ? "closeHistory"
    : !ready
      ? null
      : fromHistory !== null && fromHistory === activeId
        ? "toHistory"
        : inNewChat
          ? null
          : "toNew";
  useFocusEffect(
    useCallback(() => {
      if (back === null) return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          setFromHistory(null);
          if (back === "toNew") open(null);
          else setHistoryOpen(back === "toHistory");
          return true;
        },
      );
      return () => subscription.remove();
    }, [back, open]),
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
    <SideDrawer
      open={historyOpen}
      onOpen={() => setHistoryOpen(true)}
      onClose={() => setHistoryOpen(false)}
      closeLabel="Close chat history"
      panel={
        <History
          status={status}
          onOpenChat={openFromHistory}
          onClose={() => setHistoryOpen(false)}
          onOpenSettings={onOpenSettings}
        />
      }
    >
      <ChatLayout
        modelSelector={{
          label: modelName,
          disabled: !ready || saving,
          onPress: () => setChoosingModel(true),
        }}
        newChatDisabled={!ready || saving || inNewChat}
        navigationDisabled={saving}
        onNewChat={() => open(null)}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={onOpenSettings}
        dock={
          <>
            {ready && <ChatNotices onOpenSettings={onOpenSettings} />}
            <ComposerRegion
              ready={ready}
              active={focused && !choosingModel}
              onOpenPhoto={setPhoto}
              onSent={() => setScrollRequest((value) => value + 1)}
            />
          </>
        }
      >
        {!ready ? (
          <AboveDock>
            <View style={styles.status}>{status}</View>
          </AboveDock>
        ) : failure ? (
          <AboveDock>
            <OpenFailure
              error={failure.error}
              onRetry={() => open(failure.id)}
              onDismiss={() => commands.dismissError()}
            />
          </AboveDock>
        ) : (
          <ChatBody
            focused={focused}
            choosingModel={choosingModel}
            onCloseModel={() => setChoosingModel(false)}
            photo={photo}
            onOpenPhoto={setPhoto}
            onClosePhoto={closePhoto}
            scrollRequest={scrollRequest}
          />
        )}
      </ChatLayout>
    </SideDrawer>
  );
}

// A route that names no destination, such as a malformed link. It has no
// chats to list, so History can't be opened from it.
export function UnknownRoute() {
  const router = useRouter();
  const colors = useColors();
  return (
    <ChatLayout
      modelSelector={null}
      newChatDisabled
      navigationDisabled
      onNewChat={() => {}}
      onOpenHistory={() => {}}
      onOpenSettings={() => router.push("/settings")}
      dock={
        <ComposerRegion
          ready={false}
          active={false}
          onOpenPhoto={() => {}}
          onSent={() => {}}
        />
      }
    >
      <AboveDock>
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
      </AboveDock>
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
