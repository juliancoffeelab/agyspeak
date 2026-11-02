import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';

import { HistoryStore, type ChatHistory } from './history';
import { mockReply } from './mockReply';

export function useChatHistory() {
  const storeRef = useRef<HistoryStore | null>(null);
  const busyRef = useRef(false);
  const [history, setHistory] = useState<ChatHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    const opening = (async () => {
      const { openDatabaseAsync } = await import('expo-sqlite');
      const db = await openDatabaseAsync('chat-history.db', { useNewConnection: true });
      const store = new HistoryStore(db);
      let saved: ChatHistory;
      try {
        await store.initialize();
        saved = await store.read();
      } catch (cause) {
        await db.closeAsync();
        throw cause;
      }
      if (mounted) {
        storeRef.current = store;
        setHistory(saved);
        setError(null);
      }
      return db;
    })();
    void opening.catch(cause => {
      console.error('Could not open chat history', cause);
      if (mounted) setError('Couldn’t open chat history. Your saved chats have not been changed.');
    });
    return () => {
      mounted = false;
      storeRef.current = null;
      void opening.then(db => db.closeAsync()).catch(() => {});
    };
  }, [attempt]);

  async function change(action: (store: HistoryStore) => Promise<ChatHistory>) {
    if (!storeRef.current || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await action(storeRef.current);
      setHistory(saved);
      setError(null);
      return true;
    } catch {
      setError('Couldn’t save that change. Please try again.');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    history, busy, error,
    retry: () => { setError(null); setAttempt(value => value + 1); },
    send: (text: string) => change(store => store.appendTurn(
      history?.activeId ?? randomUUID(), text, mockReply(text), Date.now(),
    )),
    select: (id: string | null) => change(store => store.select(id)),
    remove: (id: string) => change(store => store.remove(id)),
  };
}
