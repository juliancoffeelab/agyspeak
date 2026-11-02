import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Alert, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { SavedChat } from './src/chat/history';
import { useChatHistory } from './src/chat/useChatHistory';
import { ChatScreen } from './src/chat/ChatScreen';
import { HistoryScreen } from './src/chat/HistoryScreen';
import { palettes } from './src/chat/theme';
import { useModelSettings } from './src/chat/useModelSettings';
import { SettingsScreen } from './src/chat/SettingsScreen';

export default function App() {
  const dark = useColorScheme() === 'dark';
  const colors = palettes[dark ? 'dark' : 'light'];
  const { history, busy, pending, error, retry, send, sendAudio, retryReply, stop, select, remove } = useChatHistory();
  const model = useModelSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState('');

  async function sendMessage() {
    const pending = draft;
    const text = pending.trim();
    if (text && await send(text, model.settings)) {
      setDraft(current => current === pending ? '' : current);
    }
  }

  async function openChat(id: string | null) {
    if (await select(id)) {
      setDraft('');
      setHistoryOpen(false);
    }
  }

  function deleteChat(chat: SavedChat) {
    Alert.alert('Delete chat?', `“${chat.title}” will be permanently deleted from this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { void remove(chat.id); } },
    ]);
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <ChatScreen
        colors={colors}
        history={history}
        busy={busy}
        error={error ?? model.error}
        pending={pending}
        connected={model.ready && Boolean(model.settings.apiKey)}
        settings={model.settings}
        onSendAudio={sendAudio}
        onStop={() => { void stop(); }}
        onRetryReply={id => { void retryReply(id, model.settings); }}
        onOpenSettings={() => setSettingsOpen(true)}
        draft={draft}
        onDraftChange={setDraft}
        onSend={sendMessage}
        onNewChat={() => { void openChat(null); }}
        onOpenHistory={() => setHistoryOpen(true)}
        onRetry={retry}
      />
      <HistoryScreen
        visible={historyOpen}
        colors={colors}
        chats={history?.chats ?? []}
        activeId={history?.activeId ?? null}
        busy={busy}
        error={error}
        onClose={() => setHistoryOpen(false)}
        onOpen={id => { void openChat(id); }}
        onDelete={deleteChat}
        onSettings={() => { setHistoryOpen(false); setSettingsOpen(true); }}
      />
      {settingsOpen && <SettingsScreen colors={colors} initial={model.settings} onSave={model.save} onClose={() => setSettingsOpen(false)} />}
    </SafeAreaProvider>
  );
}
