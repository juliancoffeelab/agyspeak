import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PhotoViewer } from "./PhotoViewer";
import { contextHasAudio, contextHasPhotos } from "./context";
import { AudioMessage } from "./AudioWaveform";
import { AudioComposer } from "./AudioComposer";
import type { ModelSettings } from "./openRouter";
import type {
  AudioInput,
  PhotoInput,
  PhotoReference,
  ChatHistory,
} from "./history";
import { ChatHeader } from "./ChatHeader";
import type { ChatColors } from "./theme";
import { useKeyboardVisible } from "./useKeyboardVisible";
import { screenStyles } from "./screenStyles";
import type { PersistentDraft } from "./PersistentDraft";
import type { PendingReply } from "./ChatController";

type ChatScreenProps = {
  colors: ChatColors;
  visible: boolean;
  history: ChatHistory | null;
  busy: boolean;
  error: string | null;
  pending: PendingReply | null;
  connected: boolean;
  settings: ModelSettings;
  audioIssue: string | null;
  imageIssue: string | null;
  onReadPhoto: (reference: PhotoReference) => Promise<PhotoInput>;
  onSendAudio: (audio: AudioInput, settings: ModelSettings) => Promise<boolean>;
  onStop: () => void;
  onRetryReply: (id: number) => void;
  onOpenSettings: () => void;
  draft: PersistentDraft | null;
  onSend: (text: string, photos?: PhotoInput[]) => Promise<boolean>;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onRetry: () => void;
};

export function ChatScreen({
  colors,
  visible,
  history,
  busy,
  error,
  pending,
  connected,
  onStop,
  onRetryReply,
  onOpenSettings,
  draft,
  onSend,
  onNewChat,
  onOpenHistory,
  onRetry,
  settings,
  audioIssue,
  imageIssue,
  onSendAudio,
  onReadPhoto,
}: ChatScreenProps) {
  const [photo, setPhoto] = useState<PhotoReference | null>(null);
  const closePhoto = useCallback(() => setPhoto(null), []);
  const [scrollRequest, setScrollRequest] = useState(0);
  const keyboardVisible = useKeyboardVisible();

  async function sendMessage(text: string, photos?: PhotoInput[]) {
    const sent = await onSend(text, photos);
    if (sent) setScrollRequest((value) => value + 1);
    return sent;
  }
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <SafeAreaView
        style={styles.screen}
        edges={keyboardVisible ? ["top", "left", "right"] : undefined}
      >
        {photo !== null && (
          <PhotoViewer
            reference={photo}
            load={onReadPhoto}
            onClose={closePhoto}
          />
        )}
        <ChatHeader
          colors={colors}
          mode="chat"
          newChatDisabled={!history || busy || history.activeId === null}
          navigationDisabled={!history || busy}
          onNewChat={onNewChat}
          onNavigate={() => {
            Keyboard.dismiss();
            onOpenHistory();
          }}
          onSettings={() => {
            Keyboard.dismiss();
            onOpenSettings();
          }}
        />
        {error !== null && (
          <View>
            <Text
              accessibilityRole="alert"
              style={[styles.error, { color: colors.text }]}
            >
              {error}
            </Text>
            {history === null && (
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={styles.retry}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>
                  Try again
                </Text>
              </Pressable>
            )}
          </View>
        )}
        <MessageList
          key={history?.activeId ?? "new"}
          colors={colors}
          history={history}
          scrollRequest={scrollRequest}
          pending={pending}
          audioIssue={
            (audioIssue && contextHasAudio(history?.messages ?? [], "")
              ? audioIssue
              : null) ??
            (imageIssue && contextHasPhotos(history?.messages ?? [], "")
              ? imageIssue
              : null)
          }
          onOpenPhoto={setPhoto}
          onRetryReply={onRetryReply}
          busy={busy || pending !== null}
        />
        {!connected && (
          <Pressable
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={styles.retry}
          >
            <Text style={[styles.actionText, { color: colors.text }]}>
              Connect OpenRouter
            </Text>
          </Pressable>
        )}
        {pending !== null && pending.chatId !== history?.activeId && (
          <Text style={[styles.error, { color: colors.muted }]}>
            Replying in another chat. You can stop it here.
          </Text>
        )}
        {draft !== null && (
          <AudioComposer
            key={draft.key}
            draft={draft}
            messages={history?.messages ?? []}
            onOpenPhoto={setPhoto}
            audioIssue={audioIssue}
            imageIssue={imageIssue}
            colors={colors}
            visible={visible}
            disabled={!history || !connected || busy}
            pending={pending !== null}
            onSendText={sendMessage}
            onStopReply={onStop}
            settings={settings}
            onSend={async (audio, chosen) => {
              const sent = await onSendAudio(audio, chosen);
              if (sent) setScrollRequest((value) => value + 1);
              return sent;
            }}
          />
        )}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function MessageList({
  colors,
  history,
  scrollRequest,
  onOpenPhoto,
  pending,
  audioIssue,
  onRetryReply,
  busy,
}: Pick<
  ChatScreenProps,
  "colors" | "history" | "onRetryReply" | "busy" | "pending" | "audioIssue"
> & {
  scrollRequest: number;
  onOpenPhoto: (reference: PhotoReference) => void;
}) {
  const listRef = useRef<LegendListRef>(null);
  const handledSendRef = useRef(scrollRequest);

  useLayoutEffect(() => {
    // Initial placement and automatic following belong to the list. Only an
    // explicit Send requests a jump after the saved messages are rendered.
    if (handledSendRef.current === scrollRequest) return;
    handledSendRef.current = scrollRequest;
    void listRef.current?.scrollToEnd({ animated: false });
  }, [scrollRequest]);

  return (
    <LegendList
      ref={listRef}
      data={history?.messages ?? []}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainVisibleContentPosition
      recycleItems
      ItemSeparatorComponent={MessageSeparator}
      keyExtractor={(message) => String(message.id)}
      style={styles.screen}
      contentContainerStyle={styles.messages}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {history === null ? "Opening your chats…" : "What’s on your mind?"}
          </Text>
          <Text style={[styles.emptyHint, { color: colors.muted }]}>
            {history === null
              ? "Your conversations stay on this phone."
              : "Send a message to start a conversation."}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <View
          style={[styles.message, item.role === "user" && styles.userMessage]}
        >
          <Text style={[styles.author, { color: colors.muted }]}>
            {item.role === "user" ? "You" : "AGSpeak"}
          </Text>
          <View
            style={
              item.role === "user" && [
                styles.bubble,
                { backgroundColor: colors.bubble },
              ]
            }
          >
            {item.photos?.map((photo, index) => (
              <Pressable
                key={photo.id}
                accessibilityRole="button"
                accessibilityLabel={`Open photo ${index + 1}`}
                onPress={() => onOpenPhoto({ id: photo.id, draft: false })}
              >
                <Image
                  source={{ uri: `data:image/jpeg;base64,${photo.thumbnail}` }}
                  accessibilityLabel={`Photo ${index + 1}`}
                  style={[
                    styles.photo,
                    { aspectRatio: photo.width / photo.height },
                  ]}
                  resizeMode="contain"
                />
              </Pressable>
            ))}
            {item.photos?.length && !item.text ? null : item.audio ? (
              <AudioMessage audio={item.audio} colors={colors} />
            ) : pending?.messageId === item.id ? (
              <StreamingReply pending={pending} colors={colors} />
            ) : (
              <Text
                selectable
                style={[styles.messageText, { color: colors.text }]}
              >
                {item.status === "pending"
                  ? "Thinking…"
                  : item.text ||
                    (item.status === "cancelled"
                      ? "Reply stopped."
                      : "Reply failed.")}
              </Text>
            )}
            {(item.status === "failed" || item.status === "cancelled") && (
              <View>
                {item.error !== null && (
                  <Text style={[styles.replyError, { color: colors.muted }]}>
                    {item.error}
                  </Text>
                )}
                {item.id === history?.messages.at(-1)?.id && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry reply"
                    disabled={busy}
                    onPress={() => {
                      if (audioIssue)
                        Alert.alert("Input unavailable", audioIssue);
                      else onRetryReply(item.id);
                    }}
                    accessibilityHint={audioIssue ?? undefined}
                    style={[
                      styles.retryReply,
                      { opacity: audioIssue ? 0.35 : 1 },
                    ]}
                  >
                    <Text style={[styles.actionText, { color: colors.text }]}>
                      Retry
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        </View>
      )}
    />
  );
}

function StreamingReply({
  pending,
  colors,
}: {
  pending: PendingReply;
  colors: ChatColors;
}) {
  const text = useSyncExternalStore(
    pending.stream.subscribe,
    pending.stream.getSnapshot,
  );
  return (
    <Text selectable style={[styles.messageText, { color: colors.text }]}>
      {text || "Thinking…"}
    </Text>
  );
}

function MessageSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  ...screenStyles,
  retry: { minHeight: 48, justifyContent: "center", paddingHorizontal: 20 },
  actionText: { fontSize: 14, fontWeight: "500" },
  messages: { padding: 20 },
  replyError: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  retryReply: { minHeight: 48, justifyContent: "center" },
  separator: { height: 24 },
  message: { alignSelf: "flex-start", maxWidth: "92%", gap: 7 },
  userMessage: { alignSelf: "flex-end", alignItems: "flex-end" },
  author: { fontSize: 12, fontWeight: "500" },
  bubble: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12 },
  photo: { width: 220, maxHeight: 280, borderRadius: 10, marginVertical: 4 },
  messageText: { fontSize: 17, lineHeight: 26 },
});
