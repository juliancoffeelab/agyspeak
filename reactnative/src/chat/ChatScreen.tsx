import { useLayoutEffect, useRef, useState } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Platform, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AudioComposer } from './AudioComposer';
import type { ModelSettings } from './openRouter';
import type { AudioInput, ChatHistory } from './history';
import { ChatHeader } from './ChatHeader';
import type { ChatColors } from './theme';
import { screenStyles } from './screenStyles';
import type { PendingReply } from './ChatController';

type ChatScreenProps = {
  colors: ChatColors;
  history: ChatHistory | null;
  busy: boolean;
  error: string | null;
  pending: PendingReply | null;
  connected: boolean;
  settings: ModelSettings;
  onSendAudio: (audio: AudioInput, settings: ModelSettings) => Promise<boolean>;
  onStop: () => void;
  onRetryReply: (id: number) => void;
  onOpenSettings: () => void;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onRetry: () => void;
};

export function ChatScreen({ colors, history, busy, error, pending, connected, onStop, onRetryReply, onOpenSettings, draft, onDraftChange, onSend, onNewChat, onOpenHistory, onRetry, settings, onSendAudio }: ChatScreenProps) {
  const [audioMode, setAudioMode] = useState(false);
  const [scrollRequest, setScrollRequest] = useState(0);
  const canSend = history !== null && connected && !pending && !busy && draft.trim().length > 0;

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
        <MessageList key={history?.activeId ?? 'new'} colors={colors} history={history} scrollRequest={scrollRequest} onRetryReply={onRetryReply} busy={busy || pending !== null} />
        {!connected && <Pressable accessibilityRole="button" onPress={onOpenSettings} style={styles.retry}>
          <Text style={[styles.actionText, { color: colors.text }]}>Connect OpenRouter</Text>
        </Pressable>}
        {pending !== null && pending.chatId !== history?.activeId && <Text style={[styles.error, { color: colors.muted }]}>Replying in another chat. You can stop it here.</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={audioMode ? 'Switch to text' : 'Switch to voice'} disabled={busy || pending !== null}
          onPress={() => setAudioMode(value => !value)} style={styles.retry}>
          <Text style={[styles.actionText, { color: colors.muted }]}>{audioMode ? 'Keyboard' : 'Voice message'}</Text>
        </Pressable>
        <View style={[styles.composer, { borderTopColor: colors.line }]}>
          {audioMode && pending === null ? <AudioComposer key={history?.activeId ?? 'new'} colors={colors} disabled={!history || !connected || busy}
            settings={settings} onSend={async (audio, chosen) => {
              const sent = await onSendAudio(audio, chosen);
              if (sent) setScrollRequest(value => value + 1);
              return sent;
            }} /> : <>
          <View style={[styles.inputFrame, { borderColor: colors.line }]}>
            <TextInput
              accessibilityLabel="Message"
              placeholder="Message…"
              placeholderTextColor={colors.muted}
              underlineColorAndroid="transparent"
              value={draft}
              onChangeText={onDraftChange}
              multiline
              maxLength={12000}
              textAlignVertical="top"
              style={[styles.input, { color: colors.text }]}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pending ? 'Stop reply' : 'Send message'}
            disabled={pending ? busy : !canSend}
            onPress={() => { if (pending) onStop(); else void sendMessage(); }}
            style={({ pressed }) => [styles.send, { backgroundColor: colors.button, opacity: !(pending ? !busy : canSend) ? 0.35 : pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.sendText, { color: colors.buttonText }]}>{pending ? 'Stop' : 'Send'}</Text>
          </Pressable>
          </>}
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function MessageList({ colors, history, scrollRequest, onRetryReply, busy }: Pick<ChatScreenProps, 'colors' | 'history' | 'onRetryReply' | 'busy'> & { scrollRequest: number }) {
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
            {history === null ? 'Your conversations stay on this phone.' : 'Send a message to start a conversation.'}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={[styles.message, item.role === 'user' && styles.userMessage]}>
          <Text style={[styles.author, { color: colors.muted }]}>{item.role === 'user' ? 'You' : 'AGSpeak'}</Text>
          <View style={item.role === 'user' && [styles.bubble, { backgroundColor: colors.bubble }]}>
            <Text selectable style={[styles.messageText, { color: colors.text }]}>
              {item.status === 'pending' ? 'Thinking…' : item.audio ? 'Voice message'  : item.text || (item.status === 'cancelled' ? 'Reply stopped.' : 'Reply failed.')}
            </Text>
            {(item.status === 'failed' || item.status === 'cancelled') && (
              <View>
                {item.error !== null && <Text style={[styles.replyError, { color: colors.muted }]}>{item.error}</Text>}
                {item.id === history?.messages.at(-1)?.id && <Pressable accessibilityRole="button" accessibilityLabel="Retry reply" disabled={busy} onPress={() => onRetryReply(item.id)} style={styles.retryReply}>
                  <Text style={[styles.actionText, { color: colors.text }]}>Retry</Text>
                </Pressable>}
              </View>
            )}
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
  replyError: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  retryReply: { minHeight: 48, justifyContent: 'center' },
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
