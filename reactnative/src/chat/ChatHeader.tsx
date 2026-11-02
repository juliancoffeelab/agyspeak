import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatColors } from './theme';

type ChatHeaderProps = {
  colors: ChatColors;
  navigation: 'history' | 'close';
  newChatDisabled: boolean;
  navigationDisabled?: boolean;
  onNewChat: () => void;
  onNavigate: () => void;
};

export function ChatHeader({ colors, navigation, newChatDisabled, navigationDisabled = false, onNewChat, onNavigate }: ChatHeaderProps) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.line }]}>
      <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>AGSpeak</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new chat"
          disabled={newChatDisabled}
          onPress={onNewChat}
          style={({ pressed }) => [styles.action, { opacity: newChatDisabled || pressed ? 0.4 : 1 }]}
        >
          <Text style={[styles.actionText, { color: colors.text }]}>New chat</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={navigation === 'history' ? 'Open chat history' : 'Close chat history'}
          disabled={navigationDisabled}
          onPress={onNavigate}
          style={({ pressed }) => [styles.action, styles.navigation, { opacity: navigationDisabled || pressed ? 0.4 : 1 }]}
        >
          <Text style={[styles.actionText, { color: colors.text }]}>{navigation === 'history' ? 'History' : 'Close'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20,
    paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12,
  },
  title: { flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  navigation: { minWidth: 72, alignItems: 'center' },
  action: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  actionText: { fontSize: 14, fontWeight: '500' },
});
