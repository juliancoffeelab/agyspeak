import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { SavedChat } from './history';
import { ChatHeader } from './ChatHeader';
import type { ChatColors } from './theme';
import { screenStyles } from './screenStyles';

type HistoryScreenProps = {
  visible: boolean;
  colors: ChatColors;
  chats: SavedChat[];
  activeId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: (id: string | null) => void;
  onDelete: (chat: SavedChat) => void;
  onSettings: () => void;
};

export function HistoryScreen({ visible, colors, chats, activeId, busy, error, onClose, onOpen, onDelete, onSettings }: HistoryScreenProps) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
          <ChatHeader
            colors={colors}
            mode="history"
            newChatDisabled={busy}
            onNewChat={() => onOpen(null)}
            onNavigate={onClose}
            onSettings={onSettings}
          />
          {error !== null && <Text accessibilityRole="alert" style={[styles.error, { color: colors.text }]}>{error}</Text>}
          <FlatList
            data={chats}
            keyExtractor={chat => chat.id}
            contentContainerStyle={styles.historyList}
            ListEmptyComponent={
              <View style={[styles.empty, styles.historyEmpty]}>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>No chats yet.</Text>
                <Text style={[styles.emptyHint, { color: colors.muted }]}>Your first message starts a saved conversation.</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.historyRow, { borderBottomColor: colors.line, backgroundColor: item.id === activeId ? colors.bubble : colors.background }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat: ${item.title}`}
                  accessibilityState={{ selected: item.id === activeId }}
                  disabled={busy}
                  onPress={() => onOpen(item.id)}
                  style={styles.historyChat}
                >
                  <Text numberOfLines={1} style={[styles.historyTitle, { color: colors.text }]}>{item.title}</Text>
                  <Text numberOfLines={1} style={[styles.historyPreview, { color: colors.muted }]}>{item.preview}</Text>
                  <Text style={[styles.historyDate, { color: colors.muted }]}>
                    {new Date(item.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete chat: ${item.title}`}
                  disabled={busy}
                  onPress={() => onDelete(item)}
                  style={styles.deleteChat}
                >
                  <Text style={[styles.deleteText, { color: colors.muted }]}>Delete</Text>
                </Pressable>
              </View>
            )}
          />

        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ...screenStyles,
  historyList: { flexGrow: 1 },
  historyEmpty: { paddingHorizontal: 20 },
  historyRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  historyChat: { flex: 1, padding: 20, gap: 7 },
  historyTitle: { fontSize: 17, fontWeight: '600' },
  historyPreview: { fontSize: 14, lineHeight: 21 },
  historyDate: { fontSize: 12 },
  deleteChat: { minHeight: 48, paddingHorizontal: 20, justifyContent: 'center' },
  deleteText: { fontSize: 14, fontWeight: '500' },
});
