import { useLayoutEffect, useRef, useState } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Platform, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ChatHistory } from './history';
import { ChatHeader } from './ChatHeader';
import type { ChatColors } from './theme';
import { screenStyles } from './screenStyles';

type ChatScreenProps = {
  colors: ChatColors;
  history: ChatHistory | null;
  busy: boolean;
  error: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onRetry: () => void;
};

export function ChatScreen({ colors, history, busy, error, draft, onDraftChange, onSend, onNewChat, onOpenHistory, onRetry }: ChatScreenProps) {
  const [scrollRequest, setScrollRequest] = useState(0);
  const canSend = history !== null && !busy && draft.trim().length > 0;

  async function sendMessage() {
    await onSend();
    setScrollRequest(value => value + 1);
  }
  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <SafeAreaView style={styles.screen}>
        <ChatHeader
          colors={colors}
          navigation="history"
          newChatDisabled={!history || busy || history.activeId === null}
          navigationDisabled={!history || busy}
          onNewChat={onNewChat}
          onNavigate={() => { Keyboard.dismiss(); onOpenHistory(); }}
        />
        {error !== null && (
          <View>
            <Text accessibilityRole="alert" style={[styles.error, { color: colors.text }]}>{error}</Text>
            {history === null && (
              <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}>
                <Text style={[styles.actionText, { color: colors.text }]}>Try again</Text>
              </Pressable>
            )}
          </View>
        )}
        <MessageList key={history?.activeId ?? 'new'} colors={colors} history={history} scrollRequest={scrollRequest} />
        <View style={[styles.composer, { borderTopColor: colors.line }]}>
          <View style={[styles.inputFrame, { borderColor: colors.line }]}>
            <TextInput
              accessibilityLabel="Message"
              placeholder="Message…"
              placeholderTextColor={colors.muted}
              underlineColorAndroid="transparent"
              value={draft}
              onChangeText={onDraftChange}
              multiline
              textAlignVertical="top"
              style={[styles.input, { color: colors.text }]}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            disabled={!canSend}
            onPress={() => { void sendMessage(); }}
            style={({ pressed }) => [styles.send, { backgroundColor: colors.button, opacity: !canSend ? 0.35 : pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.sendText, { color: colors.buttonText }]}>Send</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function MessageList({ colors, history, scrollRequest }: Pick<ChatScreenProps, 'colors' | 'history'> & { scrollRequest: number }) {
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
      keyExtractor={message => String(message.id)}
      style={styles.screen}
      contentContainerStyle={styles.messages}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{history === null ? 'Opening your chats…' : 'What’s on your mind?'}</Text>
          <Text style={[styles.emptyHint, { color: colors.muted }]}>
            {history === null ? 'Your conversations stay on this phone.' : 'Try a message. Replies are mocked for now.'}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={[styles.message, item.role === 'user' && styles.userMessage]}>
          <Text style={[styles.author, { color: colors.muted }]}>{item.role === 'user' ? 'You' : 'AGSpeak'}</Text>
          <View style={item.role === 'user' && [styles.bubble, { backgroundColor: colors.bubble }]}>
            <Text selectable style={[styles.messageText, { color: colors.text }]}>{item.text}</Text>
          </View>
        </View>
      )}
    />
  );
}

function MessageSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  ...screenStyles,
  retry: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 20 },
  actionText: { fontSize: 14, fontWeight: '500' },
  messages: { padding: 20 },
  separator: { height: 24 },
  message: { alignSelf: 'flex-start', maxWidth: '92%', gap: 7 },
  userMessage: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  author: { fontSize: 12, fontWeight: '500' },
  bubble: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12 },
  messageText: { fontSize: 17, lineHeight: 26 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 10, borderTopWidth: StyleSheet.hairlineWidth },
  inputFrame: { flex: 1, borderWidth: 1, borderRadius: 16 },
  input: { minHeight: 48, maxHeight: 160, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, lineHeight: 23 },
  send: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 16 },
  sendText: { fontSize: 15, fontWeight: '600' },
});
