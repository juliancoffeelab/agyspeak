import type { SQLiteDatabase } from 'expo-sqlite';

export type Message = { id: number; role: 'user' | 'assistant'; text: string };
export type SavedChat = { id: string; title: string; updatedAt: number; preview: string };
export type ChatHistory = { chats: SavedChat[]; activeId: string | null; messages: Message[] };

export class HistoryStore {
  private readonly db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) { this.db = db; }

  async initialize() {
    await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const version = await this.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if (version && version.user_version > 1) throw new Error('Unsupported history database version');
    if (version?.user_version === 0) {
      await this.db.withExclusiveTransactionAsync(async tx => {
        await tx.execAsync(`
          CREATE TABLE chats (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
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
          PRAGMA user_version = 1;
        `);
      });
    }
  }

  read(): Promise<ChatHistory> {
    return this.readFrom(this.db);
  }

  private async readFrom(db: Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>): Promise<ChatHistory> {
    const state = await db.getFirstAsync<{ activeId: string | null }>(
      'SELECT active_chat_id AS activeId FROM app_state WHERE id = 1',
    );
    const activeId = state?.activeId ?? null;
    const chats = await db.getAllAsync<SavedChat>(`
      SELECT c.id, c.title, c.updated_at AS updatedAt,
        (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS preview
      FROM chats c ORDER BY c.updated_at DESC, c.rowid DESC
    `);
    const messages = activeId === null ? [] : await db.getAllAsync<Message>(
      'SELECT id, role, text FROM messages WHERE chat_id = ? ORDER BY id', activeId,
    );
    return { chats, activeId, messages };
  }

  async select(id: string | null) {
    await this.db.runAsync('UPDATE app_state SET active_chat_id = ? WHERE id = 1', id);
    return this.read();
  }

  async appendTurn(id: string, text: string, reply: string, now: number) {
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 70);
    let saved: ChatHistory | undefined;
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync(`
        INSERT INTO chats (id, title, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `, id, title, now);
      await tx.runAsync('INSERT INTO messages (chat_id, role, text) VALUES (?, ?, ?)', id, 'user', text);
      await tx.runAsync('INSERT INTO messages (chat_id, role, text) VALUES (?, ?, ?)', id, 'assistant', reply);
      await tx.runAsync('UPDATE app_state SET active_chat_id = ? WHERE id = 1', id);
      // A refresh failure must roll back the turn too, so retrying cannot
      // duplicate a save that the screen reported as failed.
      saved = await this.readFrom(tx);
    });
    if (!saved) throw new Error('Transaction did not produce a history snapshot');
    return saved;
  }

  async remove(id: string) {
    await this.db.runAsync('DELETE FROM chats WHERE id = ?', id);
    return this.read();
  }
}
