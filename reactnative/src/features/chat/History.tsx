import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useState, type ReactNode } from "react";

import type { ChatSummary } from "./storage/contracts";
import { ChatHeader } from "../../ui/ChatHeader";
import { Screen } from "../../ui/Screen";
import { Toast } from "../../ui/Toast";
import { useColors } from "../../ui/theme";
import { screenStyles } from "../../ui/screenStyles";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import Trash from "lucide-react-native/icons/trash";
import { Failure } from "../../ui/Failure";
import ImageIcon from "lucide-react-native/icons/image";
import PencilLine from "lucide-react-native/icons/pencil-line";
import {
  useChatScope,
  useOpenChatScope,
  useChatState,
  useOpenChatState,
  useDraftPreview,
  useDrafted,
} from "./chatContext";

// A chat its first message has saved, which has a title and can be deleted.
type SavedChat = ChatSummary & { title: string };
const isSaved = (chat: ChatSummary): chat is SavedChat => chat.title !== null;

// Saved chats, in the panel beside the chat: opening one, starting a new chat
// and confirmed deletion. It stays mounted while the panel is closed, so it
// keeps its place in the list. `status` fills the list's place until the
// chats are open.
export function History({
  status,
  onOpenChat,
  onClose,
  onOpenSettings,
}: {
  status: ReactNode;
  // Null opens the new chat.
  onOpenChat: (id: string | null) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const colors = useColors();
  const busy = useOpenChatState((state) => state.saving, true);
  const open = useOpenChatScope() !== null;
  return (
    <Screen keyboard="pad" background={colors.background}>
      <ChatHeader
        mode="history"
        newChatDisabled={!open || busy}
        navigationDisabled={false}
        onNewChat={() => onOpenChat(null)}
        onNavigate={onClose}
        onSettings={onOpenSettings}
      />
      {open ? (
        <OpenHistory onOpenChat={onOpenChat} />
      ) : (
        <View style={[styles.screen, styles.pending]}>{status}</View>
      )}
    </Screen>
  );
}

function OpenHistory({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const colors = useColors();
  const { chat: commands } = useChatScope();
  const chats = useChatState((state) => state.history.chats);
  const chatsFailure = useChatState((state) => state.chatsFailure);
  const activeId = useChatState((state) => state.history.activeId);
  const busy = useChatState((state) => state.saving);
  const error = useChatState((state) => state.error);
  const unsent = useChatState((state) => state.history.messages.length === 0);
  // The open chat's draft is the live one; the list has it as last saved.
  const activeDrafted = useDrafted(
    activeId,
    chats?.find((chat) => chat.id === activeId)?.draft ?? null,
  );

  const [deleting, setDeleting] = useState<SavedChat | null>(null);

  return (
    <View style={styles.screen}>
      {error !== null && (
        <Toast message={error} onDismiss={() => commands.dismissError()} />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete chat?"
          message={`“${deleting.title}” will be permanently deleted from this phone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          tone="danger"
          onConfirm={() => {
            setDeleting(null);
            void commands.remove(deleting.id);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
      <FlatList
        // The new chat is listed only while it holds an unsent draft. The
        // open one is known before the chats are listed, or if they can't be.
        data={(
          chats ??
          (unsent
            ? [
                {
                  id: activeId,
                  title: null,
                  updatedAt: 0,
                  preview: "",
                  draft: null,
                },
              ]
            : [])
        ).filter(
          (chat) =>
            isSaved(chat) ||
            (chat.id === activeId ? activeDrafted : chat.draft !== null),
        )}
        keyExtractor={(row) => row.id}
        contentContainerStyle={styles.historyList}
        ListFooterComponent={
          chats !== null ? undefined : chatsFailure !== null ? (
            <View style={styles.listState}>
              <Failure
                message="Couldn’t list the saved chats."
                hint={null}
                error={chatsFailure}
                onRetry={() => void commands.loadChats()}
                onDismiss={null}
              />
            </View>
          ) : (
            <ActivityIndicator
              accessibilityLabel="Loading saved chats"
              color={colors.muted}
              style={styles.listState}
            />
          )
        }
        ListEmptyComponent={
          chats === null ? undefined : (
            <View style={[styles.empty, styles.historyEmpty]}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                No chats yet.
              </Text>
              <Text style={[styles.emptyHint, { color: colors.muted }]}>
                Your first message starts a saved conversation.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <ChatRow
            item={item}
            active={item.id === activeId}
            busy={busy}
            onOpen={() => onOpenChat(item.id)}
            onDelete={setDeleting}
          />
        )}
      />
    </View>
  );
}

// A chat listed like any other; the new chat has no title or date yet and
// nothing saved to delete. An unsent draft replaces
// the last-message preview; a spinner marks a chat that is replying.
function ChatRow({
  item,
  active,
  busy,
  onOpen,
  onDelete,
}: {
  item: ChatSummary;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: (chat: SavedChat) => void;
}) {
  const colors = useColors();
  const chat = isSaved(item) ? item : null;
  const draft = useDraftPreview(item.id, item.draft);
  const replying = useChatState((state) =>
    state.pending.some((run) => run.chatId === item.id),
  );
  const title = chat?.title ?? "New chat";
  const draftText = draft?.text.trim().replace(/\s+/g, " ") ?? "";
  const label = [
    chat ? `Open chat: ${title}` : "Open new chat",
    replying && "replying",
    draft &&
      `unsent draft${draftText && `: ${draftText}`}${
        draft.photos > 0 ? `, ${photoCount(draft.photos)}` : ""
      }`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View
      style={[
        styles.historyRow,
        {
          borderBottomColor: colors.line,
          backgroundColor: active ? colors.bubble : colors.background,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        disabled={busy}
        onPress={onOpen}
        style={styles.historyChat}
      >
        <View style={styles.titleLine}>
          <Text
            numberOfLines={1}
            style={[
              styles.historyTitle,
              styles.titleText,
              { color: colors.text },
            ]}
          >
            {title}
          </Text>
          {replying && <ActivityIndicator size="small" color={colors.muted} />}
        </View>
        {draft ? (
          <View style={styles.draftLine}>
            <PencilLine size={16} color={colors.text} />
            {draftText !== "" && (
              <Text
                numberOfLines={1}
                style={[
                  styles.historyPreview,
                  styles.draftText,
                  { color: colors.text },
                ]}
              >
                {draftText}
              </Text>
            )}
            {draft.photos > 0 && (
              <View style={styles.draftPhotos}>
                <ImageIcon size={16} color={colors.muted} />
                {draft.photos > 1 && (
                  <Text style={[styles.historyDate, { color: colors.muted }]}>
                    {draft.photos}
                  </Text>
                )}
              </View>
            )}
          </View>
        ) : (
          chat?.preview && (
            <Text
              numberOfLines={1}
              style={[styles.historyPreview, { color: colors.muted }]}
            >
              {chat.preview}
            </Text>
          )
        )}
        {chat && (
          <Text style={[styles.historyDate, { color: colors.muted }]}>
            {new Date(chat.updatedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        )}
      </Pressable>
      {chat && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete chat: ${title}`}
          disabled={busy}
          onPress={() => onDelete(chat)}
          style={styles.deleteChat}
        >
          <Trash size={20} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}

function photoCount(count: number) {
  return count === 1 ? "1 photo" : `${count} photos`;
}

const styles = StyleSheet.create({
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  titleText: { flexShrink: 1 },
  ...screenStyles,
  historyList: { flexGrow: 1 },
  historyEmpty: { paddingHorizontal: 20 },
  listState: { padding: 20, gap: 8 },
  pending: { padding: 20 },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  historyChat: { flex: 1, padding: 20, gap: 7 },
  historyTitle: { fontSize: 17, fontWeight: "600" },
  historyPreview: { fontSize: 14, lineHeight: 21 },
  historyDate: { fontSize: 12 },
  draftLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  draftText: { flexShrink: 1 },
  draftPhotos: { flexDirection: "row", alignItems: "center", gap: 2 },
  deleteChat: {
    minHeight: 48,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
});
