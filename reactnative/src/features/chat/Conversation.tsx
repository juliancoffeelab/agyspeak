import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";

import {
  MessageActions,
  type EntryAction,
  type ShownEntry,
} from "./MessageActions";
import { CompactionMarker, type CompactionMark } from "./CompactionMarker";
import { MarkdownMessage } from "./MarkdownMessage";
import { AudioMessage } from "./AudioWaveform";
import { useChatScope, useChatState, useOpenChat } from "./chatContext";
import { COMPACTION_FAILED } from "./runtime/compaction";
import {
  budgetOf,
  requestSize,
  type Log,
  type Refusal,
  type ReplyEntry,
  type UserEntry,
} from "./runtime/log";
import {
  ENDINGS,
  faultReason,
  NOT_CUT_OFF,
  refusal,
  UNSAVED,
  type Chat,
  type Fault,
  type Phase,
} from "./runtime/machine";
import type { StreamingText } from "./runtime/StreamingText";
import type { PhotoReference } from "./storage/contracts";
import { useDockedList } from "../../ui/Screen";
import { notify } from "../../ui/notice";
import { useColors } from "../../ui/theme";
import { screenStyles } from "../../ui/screenStyles";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Failure } from "../../ui/Failure";

// One row of the conversation: an entry of the log, or what the chat's
// phase adds after it (the message waiting for room, the reply being
// written, the compaction being made or failed, the failed reply's actions,
// a failed save). A row that becomes an entry keeps its key, its index.
type Row =
  | { kind: "user"; key: string; entry: UserEntry }
  | {
      kind: "reply";
      key: string;
      entry: ReplyEntry;
      writing: boolean;
      // A part after the first of its reply, which carries on from it.
      continued: boolean;
      // How it ended, as the screen words it, or null when it is complete
      // or the failure card below says it.
      note: string | null;
      // On a reply's last part: the reply as a whole, and whether it is the
      // chat's latest.
      whole: { entry: ShownEntry; latest: boolean } | null;
    }
  | { kind: "marker"; key: string; mark: CompactionMark }
  | { kind: "failed"; key: string; fault: Fault | null }
  | { kind: "unsaved"; key: string; cause: unknown };

// A part being written, as it shows before its entry is made.
const WRITING_PART: ReplyEntry = {
  kind: "reply",
  status: "complete",
  text: "",
  ending: null,
  providerMessage: null,
  model: null,
  usage: null,
  maxTokens: null,
  compaction: null,
  postedAt: null,
  elapsedMillis: null,
};

const sum = (values: (number | null)[]) =>
  values.some((value) => value !== null)
    ? values.reduce<number>((all, value) => all + (value ?? 0), 0)
    : null;

// The rows of `chat`: its log, then what its phase adds.
function conversationRows(
  chatId: string,
  chat: Chat,
  held: (log: Log, index: number, current: boolean) => CompactionMark,
  compact: () => void,
): Row[] {
  const { log } = chat;
  const phase: Phase =
    chat.phase.kind === "unsaved" ? chat.phase.resume : chat.phase;
  const rows: Row[] = [];
  const parts: ReplyEntry[] = [];
  const latestCompaction = log.findLastIndex(
    (entry) => entry.kind === "compaction",
  );
  // The reply rows since the last message, to mark its last part.
  let group: Extract<Row, { kind: "reply" }>[] = [];
  const close = (latest: boolean) => {
    const last = group.at(-1);
    if (last && !last.writing) {
      const text = parts.map((part) => part.text).join("");
      last.whole = {
        entry: {
          key: `${chatId}:${last.key}`,
          role: "assistant",
          text: text.trim() ? text : null,
          postedAt: parts[0].postedAt,
          elapsedMillis: sum(parts.map((part) => part.elapsedMillis)),
          usage: {
            promptTokens: sum(
              parts.map((part) => part.usage?.promptTokens ?? null),
            ),
            completionTokens: sum(
              parts.map((part) => part.usage?.completionTokens ?? null),
            ),
            cachedPromptTokens: sum(
              parts.map((part) => part.usage?.cachedPromptTokens ?? null),
            ),
          },
        },
        latest,
      };
    }
    group = [];
    parts.length = 0;
  };
  // A failure known in this session is told by its card.
  const told = phase.kind === "failed" && phase.fault !== null;
  const reply = (key: number, entry: ReplyEntry, writing: boolean) => {
    const row = {
      kind: "reply" as const,
      key: String(key),
      entry,
      writing,
      continued: group.length > 0,
      note:
        entry.ending === null || (entry.status === "failed" && told)
          ? null
          : entry.providerMessage === null
            ? ENDINGS[entry.ending]
            : `${ENDINGS[entry.ending]}\n${entry.providerMessage}`,
      whole: null,
    };
    group.push(row);
    parts.push(entry);
    rows.push(row);
  };
  log.forEach((entry, index) => {
    if (entry.kind === "user") {
      close(false);
      rows.push({ kind: "user", key: String(index), entry });
    } else if (entry.kind === "reply") reply(index, entry, false);
    else
      rows.push({
        kind: "marker",
        key: String(index),
        mark: held(log, index, index === latestCompaction),
      });
  });
  const running: Row = {
    kind: "marker",
    key: "compaction",
    mark: { status: "running" },
  };
  if (phase.kind === "making-room") {
    if (!phase.retry) {
      close(false);
      rows.push(running, {
        kind: "user",
        key: String(log.length + phase.passes.length),
        entry: phase.message,
      });
    } else rows.push(running);
  } else if (phase.kind === "writing") reply(log.length, WRITING_PART, true);
  else if (phase.kind === "continuing") {
    if (phase.cut.part) reply(log.length, phase.cut.part, false);
    rows.push(running);
  } else if (phase.kind === "compacting") rows.push(running);
  else if (phase.kind === "compaction-failed")
    rows.push({
      kind: "marker",
      key: "compaction",
      mark: {
        status: "failed",
        message: phase.blocked?.reason ?? COMPACTION_FAILED,
        error: phase.blocked
          ? refusalError(phase.blocked)
          : faultError(phase.fault),
        // The same request would fail the same way.
        onCompact: phase.blocked === null ? compact : null,
      },
    });
  close(true);
  if (phase.kind === "failed")
    rows.push({ kind: "failed", key: "failed", fault: phase.fault });
  if (chat.phase.kind === "unsaved")
    rows.push({ kind: "unsaved", key: "unsaved", cause: chat.phase.cause });
  return rows;
}

// A fault as a failure's details: the error thrown, or the refusal's.
const faultError = (fault: Fault): unknown =>
  fault.kind === "thrown" ? fault.cause : refusalError(fault.refusal);

// A refusal as a failure's details: its reason, then each fact it was
// decided from on a line of its own. Nothing was thrown, so it has no stack.
function refusalError(refusal: Refusal): Error {
  const error = new Error(
    [
      refusal.reason,
      ...Object.entries(refusal.facts).map(
        ([name, value]) => `${name}: ${value}`,
      ),
    ].join("\n"),
  );
  error.stack = undefined;
  return error;
}

// The log's entries, rows of what the chat's phase adds, and what can be
// done with its latest reply, for the open chat.
export function Conversation({
  scrollRequest,
  onOpenPhoto,
}: {
  scrollRequest: number;
  onOpenPhoto: (reference: PhotoReference) => void;
}) {
  const colors = useColors();
  const chatId = useOpenChat((view) => view.id);
  const chat = useOpenChat((view) => view.chat);
  const stream = useOpenChat((view) => view.stream);
  const thumbnails = useOpenChat((view) => view.thumbnails);
  const busy = useChatState((state) => state.busy);
  const { chat: commands, speech } = useChatScope();
  // A reply isn't asked for again in the middle of a recording.
  const recording = useSyncExternalStore(
    speech.subscribe,
    () => speech.getSnapshot().recording,
  );
  const rows = useMemo(
    () =>
      conversationRows(
        chatId,
        chat,
        (log, index, current) => ({
          status: "held",
          current,
          id: [chatId, index, log.length],
          load: () => commands.shownFrom(log, index),
        }),
        () => run("compact"),
      ),
    // `run` reads only `commands`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, chat, commands],
  );
  // How full the chat is, told on its latest reply: at most this many
  // tokens of its limit.
  const gauge = useMemo(
    () => ({
      tokens: requestSize(chat.log, chat.model),
      limit: budgetOf(chat.model).limit,
    }),
    [chat.log, chat.model],
  );

  // What the menu of the latest reply offers, and why each can't be done
  // now: told when it is pressed.
  function run(kind: keyof typeof TITLES) {
    const refused = commands.command({ kind });
    if (refused) notify(TITLES[kind], refused);
  }
  function action(
    kind: "retry" | "continue" | "discard",
    onPress: () => void,
  ): EntryAction {
    const issue = refusal(chat, kind);
    return {
      kind,
      issue,
      disabled: busy || recording,
      onPress: () => (issue ? notify(TITLES[kind], issue) : onPress()),
    };
  }
  // The finished reply awaiting confirmation that a new one may replace it.
  const [replacing, setReplacing] = useState(false);
  function latestActions(entry: ReplyEntry): EntryAction[] {
    return [
      action("retry", () =>
        // Only a finished reply has something to lose.
        entry.status === "complete" ? setReplacing(true) : run("retry"),
      ),
      // Offered on a reply cut off at a limit.
      ...(refusal(chat, "continue") === NOT_CUT_OFF
        ? []
        : [action("continue", () => run("continue"))]),
      ...(chat.phase.kind === "failed"
        ? [action("discard", () => run("discard"))]
        : []),
    ];
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
      {replacing && (
        <ConfirmDialog
          title="Want a different answer?"
          message="The model answers again, and this answer is replaced."
          confirmLabel="Ask again"
          cancelLabel="Cancel"
          tone="neutral"
          onConfirm={() => {
            setReplacing(false);
            run("retry");
          }}
          onCancel={() => setReplacing(false)}
        />
      )}
      <KeyboardAwareLegendList
        ref={listRef}
        {...docked}
        data={rows}
        // A row is redrawn only when it or this changes: everything rows
        // read besides themselves.
        extraData={`${gauge.tokens}:${gauge.limit}:${busy}:${recording}:${stream !== null}`}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition
        recycleItems
        ItemSeparatorComponent={MessageSeparator}
        keyExtractor={(row) => row.key}
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
          if (item.kind === "marker")
            return <CompactionMarker mark={item.mark} />;
          if (item.kind === "unsaved")
            return (
              <Failure
                message={UNSAVED}
                hint={null}
                error={item.cause}
                onRetry={() => run("save-again")}
                onDismiss={null}
              />
            );
          if (item.kind === "failed" && item.fault !== null) {
            const retry = action("retry", () => run("retry"));
            const discard = action("discard", () => run("discard"));
            const press = (shown: EntryAction) => () => {
              if (!shown.disabled) shown.onPress();
            };
            return (
              <Failure
                message={faultReason(item.fault)}
                hint={null}
                error={faultError(item.fault)}
                onRetry={press(retry)}
                onDismiss={press(discard)}
              />
            );
          }
          if (item.kind === "failed")
            return (
              <View style={styles.failedActions}>
                {(["retry", "discard"] as const).map((kind) => {
                  const shown = action(kind, () => run(kind));
                  return (
                    <Pressable
                      key={kind}
                      accessibilityRole="button"
                      accessibilityLabel={
                        kind === "retry" ? "Retry reply" : "Discard reply"
                      }
                      accessibilityHint={shown.issue ?? undefined}
                      disabled={shown.disabled}
                      onPress={shown.onPress}
                      style={[
                        styles.retryReply,
                        { opacity: shown.issue ? 0.35 : 1 },
                      ]}
                    >
                      <Text style={[styles.actionText, { color: colors.text }]}>
                        {kind === "retry" ? "Retry" : "Discard"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            );
          if (item.kind === "user") {
            const { entry } = item;
            return (
              <View style={[styles.message, styles.userMessage]}>
                <Text style={[styles.author, { color: colors.muted }]}>
                  You
                </Text>
                <View
                  style={[styles.bubble, { backgroundColor: colors.bubble }]}
                >
                  {entry.photos.map((photo, index) => (
                    <Pressable
                      key={photo.key}
                      accessibilityRole="button"
                      accessibilityLabel={`Open photo ${index + 1}`}
                      onPress={() =>
                        onOpenPhoto({
                          draft: false,
                          key: photo.key,
                          width: photo.width,
                          height: photo.height,
                        })
                      }
                    >
                      <Image
                        source={{
                          uri: `data:image/jpeg;base64,${thumbnails[photo.key] ?? ""}`,
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
                  {entry.audio ? (
                    <AudioMessage
                      audio={{
                        format: entry.audio.format,
                        ...(entry.audio.durationMillis === null
                          ? {}
                          : { durationMillis: entry.audio.durationMillis }),
                        ...(entry.audio.levels === null
                          ? {}
                          : { levels: entry.audio.levels }),
                      }}
                    />
                  ) : entry.text ? (
                    <Text
                      selectable
                      style={[styles.messageText, { color: colors.text }]}
                    >
                      {entry.text}
                    </Text>
                  ) : null}
                </View>
                <MessageActions
                  message={{
                    key: `${chatId}:${item.key}`,
                    role: "user",
                    text: entry.audio || !entry.text.trim() ? null : entry.text,
                    postedAt: entry.postedAt,
                    elapsedMillis: null,
                    usage: null,
                  }}
                  gauge={null}
                  writing={false}
                  actions={NO_ACTIONS}
                />
              </View>
            );
          }
          const { entry, whole, note } = item;
          return (
            <View style={styles.message}>
              {!item.continued && (
                <Text style={[styles.author, { color: colors.muted }]}>
                  AGSpeak
                </Text>
              )}
              <View>
                <ReplyText
                  stream={item.writing ? stream : null}
                  text={entry.text}
                />
                {note !== null && (
                  <Text style={[styles.replyError, { color: colors.muted }]}>
                    {note}
                  </Text>
                )}
                {(whole || item.writing) && (
                  <MessageActions
                    message={
                      whole?.entry ?? {
                        key: `${chatId}:${item.key}`,
                        role: "assistant",
                        text: null,
                        postedAt: null,
                        elapsedMillis: null,
                        usage: null,
                      }
                    }
                    gauge={whole?.latest ? gauge : null}
                    writing={item.writing}
                    actions={whole?.latest ? latestActions(entry) : NO_ACTIONS}
                  />
                )}
              </View>
            </View>
          );
        }}
      />
    </>
  );
}

const NO_ACTIONS: readonly EntryAction[] = [];

const TITLES = {
  retry: "Couldn’t retry",
  continue: "Couldn’t continue",
  discard: "Couldn’t discard",
  compact: "Couldn’t compact",
  "save-again": "Couldn’t save",
} as const;

const noStream = () => () => undefined;

// A reply part's text, from its stream while it is being written and from
// its entry afterwards. One component shows both, so that finishing a part
// changes nothing on screen.
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
  if (!shown && stream !== null)
    return (
      <Text selectable style={[styles.messageText, { color: colors.text }]}>
        Thinking…
      </Text>
    );
  if (!shown.trim()) return null;
  return <MarkdownMessage text={shown} writing={stream !== null} />;
}

function MessageSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  ...screenStyles,
  actionText: { fontSize: 14, fontWeight: "500" },
  messages: { padding: 20 },
  replyError: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  failedActions: { flexDirection: "row", gap: 24 },
  retryReply: { minHeight: 48, justifyContent: "center" },
  separator: { height: 24 },
  message: { alignSelf: "flex-start", maxWidth: "92%", gap: 7 },
  userMessage: { alignSelf: "flex-end", alignItems: "flex-end" },
  author: { fontSize: 12, fontWeight: "500" },
  bubble: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12 },
  photo: { width: 220, maxHeight: 280, borderRadius: 10, marginVertical: 4 },
  messageText: { fontSize: 17, lineHeight: 26 },
});
