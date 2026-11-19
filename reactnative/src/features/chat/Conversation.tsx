import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";

import { ResponseActions } from "./ResponseActions";
import { MarkdownMessage } from "./MarkdownMessage";
import { AudioMessage } from "./AudioWaveform";
import { useChatModel, useChatScope, useChatState } from "./chatContext";
import { inputIssue } from "./runtime/capability";
import type { StreamingText } from "./runtime/StreamingText";
import type { PhotoReference } from "./storage/contracts";
import { openReply, REPLY_UNSAVED } from "./runtime/coordinator";
import { useDockedList } from "../../ui/Screen";
import { notify } from "../../ui/notice";
import { useColors } from "../../ui/theme";
import { screenStyles } from "../../ui/screenStyles";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Failure } from "../../ui/Failure";

// Message presentation, scroll intent and reply actions for the open chat.
export function Conversation({
  scrollRequest,
  onOpenPhoto,
}: {
  scrollRequest: number;
  onOpenPhoto: (reference: PhotoReference) => void;
}) {
  const colors = useColors();
  const history = useChatState((state) => state.history);
  const pending = useChatState(openReply);
  const unsavedReplies = useChatState((state) => state.unsavedReplies);
  const busy = useChatState(
    (state) => state.saving || openReply(state) !== null,
  );
  const { chat: commands, speech } = useChatScope();
  // A reply isn't asked for again in the middle of a recording.
  const recording = useSyncExternalStore(
    speech.subscribe,
    () => speech.getSnapshot().recording,
  );
  const model = useChatModel();
  // Why the chat's model can't answer this conversation again.
  const retryIssue = inputIssue(history.messages, null, {
    audio: model.audioIssue,
    image: model.imageIssue,
  });
  // The finished reply awaiting confirmation that a new one may replace it.
  const [replacing, setReplacing] = useState<number | null>(null);
  function retry(id: number) {
    if (retryIssue) notify("Input unavailable", retryIssue);
    else void commands.retryReply(id);
  }
  const listRef = useRef<LegendListRef>(null);
  const docked = useDockedList();
  const handledSendRef = useRef(scrollRequest);

  useLayoutEffect(() => {
    // Initial placement and automatic following belong to the list. Only an
    // explicit Send requests a jump after the saved messages are rendered.
    if (handledSendRef.current === scrollRequest) return;
    handledSendRef.current = scrollRequest;
    void listRef.current?.scrollToEnd({ animated: false });
  }, [scrollRequest]);

  return (
    <>
      {replacing !== null && (
        <ConfirmDialog
          title="Want a different answer?"
          message="The model answers again, and this answer is replaced."
          confirmLabel="Ask again"
          cancelLabel="Cancel"
          tone="neutral"
          onConfirm={() => {
            setReplacing(null);
            retry(replacing);
          }}
          onCancel={() => setReplacing(null)}
        />
      )}
      <KeyboardAwareLegendList
        ref={listRef}
        {...docked}
        data={history.messages}
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
              What’s on your mind?
            </Text>
            <Text style={[styles.emptyHint, { color: colors.muted }]}>
              Send a message to start a conversation.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const unsaved = unsavedReplies.find(
            (reply) => reply.messageId === item.id,
          );
          const latest = item.id === history.messages.at(-1)?.id;
          const writing = pending?.messageId === item.id;
          return (
            <View
              style={[
                styles.message,
                item.role === "user" && styles.userMessage,
              ]}
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
                      source={{
                        uri: `data:image/jpeg;base64,${photo.thumbnail}`,
                      }}
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
                  <AudioMessage audio={item.audio} />
                ) : writing ? (
                  <ReplyText stream={pending.stream} text="" />
                ) : unsaved?.outcome.text ? (
                  <ReplyText stream={null} text={unsaved.outcome.text} />
                ) : item.role === "assistant" &&
                  item.status !== "pending" &&
                  item.text ? (
                  <ReplyText stream={null} text={item.text} />
                ) : (
                  <Text
                    selectable
                    style={[styles.messageText, { color: colors.text }]}
                  >
                    {item.status === "pending"
                      ? unsaved
                        ? (unsaved.outcome.error ?? "Reply finished.")
                        : "Thinking…"
                      : item.text ||
                        (item.status === "cancelled"
                          ? "Reply stopped."
                          : "Reply failed.")}
                  </Text>
                )}
                {item.role === "assistant" &&
                  (writing ||
                    (item.status !== "pending" && item.text.trim())) && (
                    <ResponseActions
                      id={item.id}
                      markdown={item.text}
                      elapsedMillis={item.elapsedMillis}
                      writing={writing}
                      retry={
                        latest && !writing
                          ? {
                              disabled: busy || recording,
                              issue: retryIssue,
                              // Only a finished reply has something to lose.
                              onPress: () =>
                                item.status === "complete"
                                  ? setReplacing(item.id)
                                  : retry(item.id),
                            }
                          : null
                      }
                    />
                  )}
                {unsaved && (
                  <Failure
                    message={REPLY_UNSAVED}
                    hint={null}
                    error={unsaved.cause}
                    onRetry={null}
                    onDismiss={null}
                  />
                )}
                {(item.status === "failed" || item.status === "cancelled") && (
                  <View>
                    {item.error !== null && (
                      <Text
                        style={[styles.replyError, { color: colors.muted }]}
                      >
                        {item.error}
                      </Text>
                    )}
                    {latest && !item.text.trim() && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry reply"
                        disabled={busy || recording}
                        onPress={() => retry(item.id)}
                        accessibilityHint={retryIssue ?? undefined}
                        style={[
                          styles.retryReply,
                          { opacity: retryIssue ? 0.35 : 1 },
                        ]}
                      >
                        <Text
                          style={[styles.actionText, { color: colors.text }]}
                        >
                          Retry
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            </View>
          );
        }}
      />
    </>
  );
}

const noStream = () => () => undefined;

// A reply's text, from its stream while it is being written and from the
// saved message afterwards. One component shows both in one Markdown view,
// so that finishing a reply changes nothing on screen.
function ReplyText({
  stream,
  text,
}: {
  stream: StreamingText | null;
  text: string;
}) {
  const colors = useColors();
  const streamed = useSyncExternalStore(
    stream ? stream.subscribe : noStream,
    () => (stream ? stream.getSnapshot() : null),
  );
  const shown = streamed ?? text;
  if (!shown)
    return (
      <Text selectable style={[styles.messageText, { color: colors.text }]}>
        Thinking…
      </Text>
    );
  return <MarkdownMessage text={shown} writing={stream !== null} />;
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
