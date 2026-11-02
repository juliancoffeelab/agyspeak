import { useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { mockReply } from './src/chat/mockReply';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

const palettes = {
  light: {
    background: '#faf9f6',
    text: '#20211f',
    muted: '#6b6d66',
    line: '#dedfd8',
    bubble: '#eaece4',
    button: '#252d25',
    buttonText: '#ffffff',
  },
  dark: {
    background: '#191b19',
    text: '#eeefe8',
    muted: '#a1a79d',
    line: '#363b35',
    bubble: '#2c322b',
    button: '#dfe9d8',
    buttonText: '#1c251b',
  },
};

export default function App() {
  const colors = palettes[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const nextIdRef = useRef(0);
  const listRef = useRef<FlatList<Message>>(null);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const canSend = draft.trim().length > 0;

  function scrollToBottom() {
    // FlatList.scrollToEnd estimates the final cell's position. Use the
    // measured content bounds so variable-height replies and padding count.
    listRef.current?.scrollToOffset({
      offset: Math.max(0, contentHeightRef.current - viewportHeightRef.current),
      animated: false,
    });
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    const id = nextIdRef.current++;
    setMessages(previous => [
      ...previous,
      { id: `${id}-user`, role: 'user', text },
      { id: `${id}-assistant`, role: 'assistant', text: mockReply(text) },
    ]);
    setDraft('');
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={colors === palettes.dark ? 'light' : 'dark'} />
      <KeyboardAvoidingView
        style={[styles.screen, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <SafeAreaView style={styles.screen}>
          <View style={[styles.header, { borderBottomColor: colors.line }]}>
            <View style={styles.identity}>
              <Text style={[styles.title, { color: colors.text }]}>AGSpeak</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start a new chat"
              disabled={messages.length === 0}
              onPress={() => { setMessages([]); setDraft(''); }}
              style={({ pressed }) => [styles.newChat, { opacity: pressed || messages.length === 0 ? 0.4 : 1 }]}
            >
              <Text style={[styles.newChatText, { color: colors.text }]}>New chat</Text>
            </Pressable>
          </View>

          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={message => message.id}
            style={styles.screen}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onContentSizeChange={(_, height) => {
              contentHeightRef.current = height;
              scrollToBottom();
            }}
            onLayout={event => {
              viewportHeightRef.current = event.nativeEvent.layout.height;
              scrollToBottom();
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>What’s on your mind?</Text>
                <Text style={[styles.emptyHint, { color: colors.muted }]}>
                  Try a message. Replies are mocked for now.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.message, item.role === 'user' && styles.userMessage]}>
                <Text style={[styles.author, { color: colors.muted }]}>
                  {item.role === 'user' ? 'You' : 'AGSpeak'}
                </Text>
                <View style={item.role === 'user' && [styles.bubble, { backgroundColor: colors.bubble }]}>
                  <Text selectable style={[styles.messageText, { color: colors.text }]}>{item.text}</Text>
                </View>
              </View>
            )}
          />

          <View style={[styles.composer, { borderTopColor: colors.line }]}>
            <View style={[styles.inputFrame, { borderColor: colors.line }]}>
              <TextInput
                accessibilityLabel="Message"
                placeholder="Message…"
                placeholderTextColor={colors.muted}
                underlineColorAndroid="transparent"
                value={draft}
                onChangeText={setDraft}
                multiline
                textAlignVertical="top"
                style={[styles.input, { color: colors.text }]}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!canSend}
              onPress={send}
              style={({ pressed }) => [styles.send, {
                backgroundColor: colors.button,
                opacity: !canSend ? 0.35 : pressed ? 0.7 : 1,
              }]}
            >
              <Text style={[styles.sendText, { color: colors.buttonText }]}>Send</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  identity: { flex: 1 },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.6 },
  newChat: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  newChatText: { fontSize: 14, fontWeight: '500' },
  messages: { flexGrow: 1, padding: 20, gap: 24 },
  empty: { flex: 1, justifyContent: 'center', paddingBottom: 48 },
  emptyTitle: { fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: -1 },
  emptyHint: { fontSize: 15, lineHeight: 23, marginTop: 12 },
  message: { alignSelf: 'flex-start', maxWidth: '92%', gap: 7 },
  userMessage: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  author: { fontSize: 12, fontWeight: '500' },
  bubble: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12 },
  messageText: { fontSize: 17, lineHeight: 26 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputFrame: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
  },
  input: {
    minHeight: 48,
    maxHeight: 160,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 23,
  },
  send: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 16 },
  sendText: { fontSize: 15, fontWeight: '600' },
});
