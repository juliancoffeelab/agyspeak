import type { SQLiteDatabase } from 'expo-sqlite';

import { selectContext, summarizeLevels } from './context.ts';

export type ReplyStatus = 'complete' | 'pending' | 'failed' | 'cancelled';
export type AudioMetadata = { format: string; durationMillis?: number; levels?: number[] };
export type AudioInput = AudioMetadata & { data: string };
export type AudioAttachment = AudioMetadata & { id: number; encodedLength: number };
export type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  status: ReplyStatus;
  replyTo: number | null;
  error: string | null;
  model: string | null;
  audio?: AudioAttachment | null;
};
export type PromptMessage = Omit<Message, 'audio'> & { audio?: AudioInput | null };
export type SavedChat = { id: string; title: string; updatedAt: number; preview: string };
export type ChatHistory = { chats: SavedChat[]; activeId: string | null; messages: Message[] };

type Reader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;

export class HistoryStore {
  private readonly db: SQLiteDatabase;
  constructor(db: SQLiteDatabase) { this.db = db; }

  async initialize() {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      let version = row?.user_version ?? 0;
      if (version > 5) throw new Error('Unsupported history database version');
      if (version === 0) {
        await tx.execAsync(`
          CREATE TABLE chats (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            text TEXT NOT NULL
          );
          CREATE INDEX messages_by_chat ON messages(chat_id, id);
          CREATE TABLE app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            active_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL
          );
          INSERT INTO app_state (id, active_chat_id) VALUES (1, NULL);
        `);
        version = 1;
      }
      if (version === 1) {
        await tx.execAsync(`
          ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
            CHECK (status IN ('complete', 'pending', 'failed', 'cancelled'));
          ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id);
          ALTER TABLE messages ADD COLUMN error TEXT;
          ALTER TABLE messages ADD COLUMN model TEXT;
          CREATE UNIQUE INDEX message_reply ON messages(reply_to) WHERE reply_to IS NOT NULL;
          CREATE UNIQUE INDEX pending_reply ON messages(chat_id) WHERE status = 'pending';
          PRAGMA user_version = 2;
        `);
      }
      if (version <= 2) {
        await tx.execAsync(`ALTER TABLE messages ADD COLUMN audio_data TEXT;
          ALTER TABLE messages ADD COLUMN audio_format TEXT; PRAGMA user_version = 3;`);
      }
      if (version <= 3) await tx.execAsync('ALTER TABLE messages ADD COLUMN audio_metadata TEXT; PRAGMA user_version = 4;');
      if (version <= 4) await tx.execAsync(`ALTER TABLE messages ADD COLUMN audio_length INTEGER;
        UPDATE messages SET audio_length = LENGTH(audio_data) WHERE audio_data IS NOT NULL; PRAGMA user_version = 5;`);
      await tx.runAsync(`UPDATE messages SET status = 'failed', error = ? WHERE status = 'pending'`,
        'The app closed before this reply finished. You can retry it.');
    });
  }

  read(): Promise<ChatHistory> { return this.readFrom(this.db); }

  private async readFrom(db: Reader): Promise<ChatHistory> {
    const state = await db.getFirstAsync<{ activeId: string | null }>('SELECT active_chat_id AS activeId FROM app_state WHERE id = 1');
    const activeId = state?.activeId ?? null;
    const chats = await db.getAllAsync<SavedChat>(`
      SELECT c.id, c.title, c.updated_at AS updatedAt,
        COALESCE((SELECT NULLIF(text, '') FROM messages WHERE chat_id = c.id AND text != '' ORDER BY id DESC LIMIT 1), '') AS preview
      FROM chats c ORDER BY c.updated_at DESC, c.rowid DESC
    `);
    const messages = activeId === null ? [] : await this.readMessages(db, activeId);
    return { chats, activeId, messages };
  }

  private async readMessages(db: Reader, chatId: string): Promise<Message[]> {
    const rows = await db.getAllAsync<Message & { audioFormat: string | null; audioMetadata: string | null; audioLength: number | null }>(
      `SELECT id, role, text, status, reply_to AS replyTo, error, model,
        audio_format AS audioFormat, audio_metadata AS audioMetadata, audio_length AS audioLength
        FROM messages WHERE chat_id = ? ORDER BY id`, chatId);
    return rows.map(({ audioFormat, audioMetadata, audioLength, ...message }) => {
      if (audioLength === null || !audioFormat) return message;
      const metadata = audioMetadata ? JSON.parse(audioMetadata) as Pick<AudioMetadata, 'durationMillis' | 'levels'> : {};
      return { ...message, audio: { ...metadata, id: message.id, encodedLength: audioLength, format: audioFormat } };
    });
  }

  async readContext(chatId: string): Promise<PromptMessage[]> {
    const selected = selectContext(await this.readMessages(this.db, chatId));
    const ids = selected.filter(message => message.audio).map(message => message.id);
    const rows = ids.length === 0 ? [] : await this.db.getAllAsync<{ id: number; data: string }>(
      `SELECT id, audio_data AS data FROM messages WHERE chat_id = ? AND id IN (${ids.map(() => '?').join(',')})`, chatId, ...ids);
    const recordings = new Map(rows.map(row => [row.id, row.data]));
    return selected.map(({ audio, ...message }) => {
      if (!audio) return message;
      const data = recordings.get(message.id);
      if (!data) throw new Error('A recording is missing from this conversation.');
      return { ...message, audio: { format: audio.format, data } };
    });
  }

  // Mutations and their return snapshot succeed or roll back together.
  private async write(action: (tx: SQLiteDatabase) => Promise<void>) {
    let saved: ChatHistory | undefined;
    await this.db.withExclusiveTransactionAsync(async tx => {
      await action(tx);
      saved = await this.readFrom(tx);
    });
    if (!saved) throw new Error('Transaction did not produce a history snapshot');
    return saved;
  }

  select(id: string | null) {
    return this.write(async tx => {
      if (id !== null && !await tx.getFirstAsync('SELECT id FROM chats WHERE id = ?', id)) throw new Error('Chat no longer exists');
      await tx.runAsync('UPDATE app_state SET active_chat_id = ? WHERE id = 1', id);
    });
  }

  beginReply(id: string, text: string, model: string, now: number, audio?: AudioInput) {
    return this.write(async tx => {
      await tx.runAsync(`INSERT INTO chats (id, title, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, id, text.replace(/\s+/g, ' ').trim().slice(0, 70), now);
      const user = await tx.runAsync('INSERT INTO messages (chat_id, role, text, audio_data, audio_format, audio_metadata, audio_length) VALUES (?, ?, ?, ?, ?, ?, ?)', id, 'user', text, audio?.data ?? null, audio?.format ?? null, audio ? JSON.stringify({ durationMillis: audio.durationMillis, levels: audio.levels ? summarizeLevels(audio.levels) : undefined }) : null, audio?.data.length ?? null);
      await tx.runAsync(`INSERT INTO messages (chat_id, role, text, status, reply_to, model) VALUES (?, 'assistant', '', 'pending', ?, ?)`,
        id, user.lastInsertRowId, model);
      await tx.runAsync('UPDATE app_state SET active_chat_id = ? WHERE id = 1', id);
    });
  }

  retryReply(id: number, model: string, now: number) {
    return this.write(async tx => {
      const result = await tx.runAsync(`UPDATE messages SET status = 'pending', text = '', error = NULL, model = ?
        WHERE id = ? AND role = 'assistant' AND status IN ('failed', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.chat_id = messages.chat_id AND newer.id > messages.id)`, model, id);
      if (result.changes !== 1) throw new Error('Only the latest failed or stopped reply can be retried');
      await tx.runAsync('UPDATE chats SET updated_at = ? WHERE id = (SELECT chat_id FROM messages WHERE id = ?)', now, id);
    });
  }

  finishReply(id: number, status: Exclude<ReplyStatus, 'pending'>, text: string, error: string | null, model: string | null = null) {
    return this.write(async tx => {
      await tx.runAsync(`UPDATE messages SET status = ?, text = ?, error = ?, model = COALESCE(?, model) WHERE id = ? AND status = 'pending'`,
        status, text, error, model, id);
    });
  }

  remove(id: string) {
    return this.write(async tx => {
      // Expo's exclusive transaction uses a separate connection, whose foreign
      // key pragma is independent. Delete dependent rows explicitly here.
      await tx.runAsync('UPDATE app_state SET active_chat_id = NULL WHERE active_chat_id = ?', id);
      await tx.runAsync('DELETE FROM messages WHERE chat_id = ?', id);
      await tx.runAsync('DELETE FROM chats WHERE id = ?', id);
    });
  }
}
