import type { SQLiteDatabase } from "expo-sqlite";

import { historyEntry, type HistoryRows } from "../../../migrations/index.ts";
import type { Connection, OrderedDatabase } from "../../../storage/database.ts";
import type { Entry, Log, PhotoRef, UserEntry } from "../runtime/log.ts";
import type {
  PhotoInput,
  PhotoAttachment,
  PhotoReference,
  ChatSummary,
} from "./contracts.ts";
import { MissingChatError, summarizeDraft } from "./contracts.ts";
import {
  encodedLength,
  megabytes,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
} from "../../../providers/openrouter/transport.ts";

type Reader = Pick<SQLiteDatabase, "getFirstAsync" | "getAllAsync">;
// The named columns of a table's row at the current schema version.
type Row<T extends keyof HistoryRows, K extends keyof HistoryRows[T]> = Pick<
  HistoryRows[T],
  K
>;

type PhotoRow = Row<
  "draft_photos",
  "id" | "thumbnail" | "width" | "height" | "encoded_length"
>;
const toAttachment = (row: PhotoRow): PhotoAttachment => ({
  id: row.id,
  thumbnail: row.thumbnail,
  width: row.width,
  height: row.height,
  encodedLength: row.encoded_length,
});

// One chat as storage committed it: its log, checked against the stored
// format, and the thumbnails of the photos it holds, by key.
export type Conversation = {
  id: string;
  log: Log;
  selectedModel: string | null;
  thumbnails: Record<string, string>;
};
// Results name the records they affect. `seq` orders results by when their
// operation ran, so a caller can reject a read older than one it applied.
export type ChatList = { seq: number; chats: ChatSummary[] };
export type NewChat = {
  id: string;
  selectedModel: string | null;
  draft: { text: string; photos: PhotoAttachment[] };
};
export type Workspace = ChatList & {
  chat: Conversation;
  draft: { text: string; photos: PhotoAttachment[] };
};
// Media saved for a message about to be sent, by the key its entry names.
export type StagedPhotos = {
  photos: PhotoRef[];
  thumbnails: Record<string, string>;
};

// A stored entry's body, read at the boundary: malformed JSON or a shape
// this version doesn't write is rejected.
function parseEntry(body: string, position: number): Entry {
  const parsed = historyEntry.safeParse(JSON.parse(body));
  if (!parsed.success)
    throw new Error(
      `Entry ${position} isn’t one this version saves: ${parsed.error.message}`,
    );
  return parsed.data;
}

// The new chat is the chat with no entries yet. It is a row like any other,
// so its draft, photos and model are stored the way a saved chat's are; its
// first message gives it a title. At most one is made at a time.
export class ChatRepository {
  private readonly db: OrderedDatabase;
  private readonly createId: () => string;
  private sequence = 0;
  constructor(db: OrderedDatabase, createId: () => string) {
    this.db = db;
    this.createId = createId;
  }

  private async newChatId(tx: Connection): Promise<string> {
    const existing = await tx.getFirstAsync<Row<"chats", "id">>(
      `SELECT id FROM chats c
        WHERE NOT EXISTS (SELECT 1 FROM entries WHERE chat_id = c.id)
        ORDER BY rowid DESC LIMIT 1`,
    );
    if (existing) return existing.id;
    const id = this.createId();
    await tx.runAsync(
      "INSERT INTO chats (id, title, updated_at, selected_model) VALUES (?, '', 0, NULL)",
      id,
    );
    return id;
  }

  // Runs after the database upgrade: deletes media no entry names, saved
  // for a message that was never sent or whose entry was dropped.
  initialize() {
    return this.db.run(async (db) => {
      await db.runAsync(
        `DELETE FROM media WHERE CAST(id AS TEXT) NOT IN (
          SELECT json_extract(body, '$.audio.key') FROM entries
            WHERE json_extract(body, '$.audio.key') IS NOT NULL
          UNION ALL
          SELECT json_extract(photo.value, '$.key')
            FROM entries, json_each(entries.body, '$.photos') AS photo
        )`,
      );
    });
  }

  // What startup opens: the new chat's model choice and draft, without the
  // list of chats, which `readChats` reads separately.
  readNewChat(): Promise<NewChat> {
    return this.transaction(async (tx) => {
      const id = await this.newChatId(tx);
      const chat = await tx.getFirstAsync<Row<"chats", "selected_model">>(
        "SELECT selected_model FROM chats WHERE id = ?",
        id,
      );
      return {
        id,
        selectedModel: chat?.selected_model ?? null,
        draft: {
          text: await this.readDraftFrom(tx, id),
          photos: await this.readPhotoDraftFrom(tx, id),
        },
      };
    });
  }

  // The new chat first, then the saved chats, newest first; ordered with
  // every update's list by `seq`.
  readChats(): Promise<ChatList> {
    return this.db.run((db) => this.readList(db));
  }

  private async readList(db: Reader): Promise<ChatList> {
    return { seq: ++this.sequence, chats: await this.readChatsFrom(db) };
  }

  private async readChatsFrom(db: Reader): Promise<ChatSummary[]> {
    const rows = await db.getAllAsync<
      Row<"chats", "id" | "title" | "updated_at"> & {
        saved: number;
        preview: string;
        draft_text: string;
        draft_photos: number;
      }
    >(`
      SELECT c.id, c.title, c.updated_at,
        EXISTS (SELECT 1 FROM entries WHERE chat_id = c.id) AS saved,
        COALESCE((SELECT json_extract(body, '$.text') FROM entries
          WHERE chat_id = c.id AND json_extract(body, '$.kind') != 'compaction'
            AND json_extract(body, '$.text') != ''
          ORDER BY position DESC LIMIT 1), '') AS preview,
        COALESCE((SELECT text FROM drafts WHERE chat_key = c.id), '') AS draft_text,
        (SELECT COUNT(*) FROM draft_photos WHERE chat_key = c.id) AS draft_photos
      FROM chats c ORDER BY saved, c.updated_at DESC, c.rowid DESC
    `);
    return rows.map((row) => ({
      id: row.id,
      title: row.saved ? row.title : null,
      updatedAt: row.updated_at,
      preview: row.preview,
      draft: summarizeDraft(row.draft_text, row.draft_photos),
    }));
  }

  private async readConversation(
    db: Reader,
    id: string,
  ): Promise<Conversation> {
    const chat = await db.getFirstAsync<Row<"chats", "selected_model">>(
      "SELECT selected_model FROM chats WHERE id = ?",
      id,
    );
    if (!chat) throw new MissingChatError();
    const rows = await db.getAllAsync<Row<"entries", "position" | "body">>(
      "SELECT position, body FROM entries WHERE chat_id = ? ORDER BY position",
      id,
    );
    const log = rows.map((row, index) => {
      if (row.position !== index)
        throw new Error(`Entry ${index} is missing from this chat.`);
      return parseEntry(row.body, index);
    });
    const thumbnails = await db.getAllAsync<Row<"media", "id" | "thumbnail">>(
      "SELECT id, thumbnail FROM media WHERE chat_id = ? AND thumbnail IS NOT NULL",
      id,
    );
    return {
      id,
      log,
      selectedModel: chat.selected_model,
      thumbnails: Object.fromEntries(
        thumbnails.map((row) => [String(row.id), row.thumbnail as string]),
      ),
    };
  }

  // Mutations and the result they return succeed or roll back together.
  private transaction<T>(action: (tx: Connection) => Promise<T>) {
    return this.db.run(async (db) => {
      let result: { value: T } | undefined;
      await db.withExclusiveTransactionAsync(async (tx) => {
        result = { value: await action(tx) };
      });
      if (!result) throw new Error("Transaction produced no result");
      return result.value;
    });
  }

  // The saved log of chat `chatId` becomes its first `keep` entries, then
  // `entries`, in one transaction, each checked as a read checks it: one
  // the app couldn't read back fails the write. The message `sent` from
  // the draft is taken from it: its text, unless it is a recording, and
  // its photos. A chat's first message titles it and fixes the model it was
  // sent with, `model`.
  writeLog(
    chatId: string,
    keep: number,
    entries: readonly Entry[],
    sent: UserEntry | null,
    model: string,
    now: number,
  ): Promise<ChatList> {
    return this.transaction(async (tx) => {
      const bodies = entries.map((entry, offset) => {
        const body = JSON.stringify(entry);
        parseEntry(body, keep + offset);
        return body;
      });
      const chat = await tx.getFirstAsync<{ count: number }>(
        "SELECT (SELECT COUNT(*) FROM entries WHERE chat_id = c.id) AS count FROM chats c WHERE c.id = ?",
        chatId,
      );
      if (!chat) throw new MissingChatError();
      if (chat.count < keep)
        throw new Error("The saved chat is shorter than what it keeps.");
      await tx.runAsync(
        "DELETE FROM entries WHERE chat_id = ? AND position >= ?",
        chatId,
        keep,
      );
      for (const [offset, body] of bodies.entries())
        await tx.runAsync(
          "INSERT INTO entries (chat_id, position, body) VALUES (?, ?, ?)",
          chatId,
          keep + offset,
          body,
        );
      if (sent !== null && sent.audio === null)
        await tx.runAsync("DELETE FROM drafts WHERE chat_key = ?", chatId);
      if (sent !== null && sent.photos.length > 0)
        await tx.runAsync(
          "DELETE FROM draft_photos WHERE chat_key = ?",
          chatId,
        );
      const first = entries.find((entry) => entry.kind === "user");
      if (chat.count === 0 && first?.kind === "user")
        await tx.runAsync(
          "UPDATE chats SET updated_at = ?, title = ?, selected_model = ? WHERE id = ?",
          now,
          (first.text || (first.audio ? "Voice message" : "Photo message"))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 70),
          model,
          chatId,
        );
      else
        await tx.runAsync(
          "UPDATE chats SET updated_at = ? WHERE id = ?",
          now,
          chatId,
        );
      return this.readList(tx);
    });
  }

  // Saves a recording for a message about to be sent; its key.
  addRecording(chatId: string, data: string): Promise<string> {
    return this.transaction(async (tx) => {
      const result = await tx.runAsync(
        `INSERT INTO media (chat_id, data, thumbnail)
          SELECT ?, ?, NULL WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?)`,
        chatId,
        data,
        chatId,
      );
      if (result.changes !== 1) throw new MissingChatError();
      return String(result.lastInsertRowId);
    });
  }

  // Saves the draft's photos for a message about to be sent, leaving the
  // draft as it is until the message's write takes it (see `writeLog`).
  stagePhotoDraft(chatId: string): Promise<StagedPhotos> {
    return this.transaction(async (tx) => {
      const rows = await tx.getAllAsync<
        Row<
          "draft_photos",
          "data" | "thumbnail" | "width" | "height" | "encoded_length"
        >
      >(
        "SELECT data, thumbnail, width, height, encoded_length FROM draft_photos WHERE chat_key = ? ORDER BY id",
        chatId,
      );
      const staged: StagedPhotos = { photos: [], thumbnails: {} };
      for (const row of rows) {
        const result = await tx.runAsync(
          "INSERT INTO media (chat_id, data, thumbnail) VALUES (?, ?, ?)",
          chatId,
          row.data,
          row.thumbnail,
        );
        const key = String(result.lastInsertRowId);
        staged.photos.push({
          key,
          width: row.width,
          height: row.height,
          encodedLength: row.encoded_length,
        });
        staged.thumbnails[key] = row.thumbnail;
      }
      return staged;
    });
  }

  // A message given back to the draft (see `ChatWorkspace`): its photos,
  // copied from where the message saved them, become the draft's when it
  // has none. The draft's photos.
  restorePhotoDraft(
    chatId: string,
    photos: readonly PhotoRef[],
  ): Promise<PhotoAttachment[]> {
    return this.transaction(async (tx) => {
      if (!(await this.photoDraftEmpty(tx, chatId)))
        return this.readPhotoDraftFrom(tx, chatId);
      await this.copyToPhotoDraft(tx, chatId, photos);
      return this.readPhotoDraftFrom(tx, chatId);
    });
  }

  // The same for a chat whose draft isn't open: its text and photos become
  // the saved draft when nothing is in it.
  restoreDraft(
    chatId: string,
    text: string,
    photos: readonly PhotoRef[],
  ): Promise<void> {
    return this.transaction(async (tx) => {
      if (
        (await this.readDraftFrom(tx, chatId)).trim() !== "" ||
        !(await this.photoDraftEmpty(tx, chatId))
      )
        return;
      if (text)
        await tx.runAsync(
          `INSERT INTO drafts (chat_key, text)
          SELECT ?, ? WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?)
          ON CONFLICT(chat_key) DO UPDATE SET text = excluded.text`,
          chatId,
          text,
          chatId,
        );
      await this.copyToPhotoDraft(tx, chatId, photos);
    });
  }

  private async photoDraftEmpty(db: Reader, chatId: string) {
    const row = await db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM draft_photos WHERE chat_key = ?",
      chatId,
    );
    return (row?.count ?? 0) === 0;
  }

  private async copyToPhotoDraft(
    tx: Connection,
    chatId: string,
    photos: readonly PhotoRef[],
  ) {
    for (const photo of photos)
      await tx.runAsync(
        `INSERT INTO draft_photos (chat_key, data, thumbnail, width, height, encoded_length)
          SELECT ?, data, thumbnail, ?, ?, ? FROM media
          WHERE id = ? AND thumbnail IS NOT NULL
            AND EXISTS (SELECT 1 FROM chats WHERE id = ?)`,
        chatId,
        photo.width,
        photo.height,
        photo.encodedLength,
        Number(photo.key),
        chatId,
      );
  }

  // The bytes of the media `keys` name, for a request.
  readMedia(keys: readonly string[]): Promise<Map<string, string>> {
    return this.db.run(async (db) => {
      const found = new Map<string, string>();
      for (const key of keys) {
        const row = await db.getFirstAsync<Row<"media", "data">>(
          "SELECT data FROM media WHERE id = ?",
          Number(key),
        );
        if (!row) throw new Error("A photo or recording is no longer saved.");
        found.set(key, row.data);
      }
      return found;
    });
  }

  // A photo whole: one of a message, by key, or of a draft, by id.
  readPhoto(reference: PhotoReference): Promise<PhotoInput> {
    return this.db.run(async (db) => {
      if (reference.draft) {
        const photo = await db.getFirstAsync<
          Row<"draft_photos", "data" | "thumbnail" | "width" | "height">
        >(
          "SELECT data, thumbnail, width, height FROM draft_photos WHERE id = ?",
          reference.id,
        );
        if (!photo) throw new Error("This photo is no longer available.");
        return photo;
      }
      const photo = await db.getFirstAsync<Row<"media", "data" | "thumbnail">>(
        "SELECT data, thumbnail FROM media WHERE id = ?",
        Number(reference.key),
      );
      if (!photo?.thumbnail)
        throw new Error("This photo is no longer available.");
      return {
        data: photo.data,
        thumbnail: photo.thumbnail,
        width: reference.width,
        height: reference.height,
      };
    });
  }

  // Internal readers take the connection they run on; public wrappers queue.
  private async readPhotoDraftFrom(db: Reader, chatId: string) {
    const rows = await db.getAllAsync<PhotoRow>(
      "SELECT id, thumbnail, width, height, encoded_length FROM draft_photos WHERE chat_key = ? ORDER BY id",
      chatId,
    );
    return rows.map(toAttachment);
  }
  private async readDraftFrom(db: Reader, chatId: string) {
    const row = await db.getFirstAsync<Row<"drafts", "text">>(
      "SELECT text FROM drafts WHERE chat_key = ?",
      chatId,
    );
    return row?.text ?? "";
  }

  readPhotoDraft(chatId: string): Promise<PhotoAttachment[]> {
    return this.db.run((db) => this.readPhotoDraftFrom(db, chatId));
  }
  readPhotoDraftData(chatId: string): Promise<PhotoInput[]> {
    return this.db.run(async (db) => {
      const rows = await db.getAllAsync<
        Row<"draft_photos", "data" | "thumbnail" | "width" | "height">
      >(
        "SELECT data, thumbnail, width, height FROM draft_photos WHERE chat_key = ? ORDER BY id",
        chatId,
      );
      return rows;
    });
  }
  addPhotoDraft(chatId: string, photos: PhotoInput[]) {
    return this.transaction(async (tx) => {
      if (
        !(await tx.getFirstAsync("SELECT id FROM chats WHERE id = ?", chatId))
      )
        throw new MissingChatError();
      const existing = await tx.getFirstAsync<{ count: number; size: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(encoded_length), 0) AS size FROM draft_photos WHERE chat_key = ?",
        chatId,
      );
      if (
        (existing?.count ?? 0) + photos.length > MAX_PHOTOS ||
        (existing?.size ?? 0) +
          photos.reduce((sum, photo) => sum + photo.data.length, 0) >
          encodedLength(MAX_PHOTO_BYTES)
      )
        throw new Error(
          `Choose up to ${MAX_PHOTOS} photos under ${megabytes(MAX_PHOTO_BYTES)} combined.`,
        );
      for (const photo of photos)
        await tx.runAsync(
          "INSERT INTO draft_photos (chat_key, data, thumbnail, width, height, encoded_length) VALUES (?, ?, ?, ?, ?, ?)",
          chatId,
          photo.data,
          photo.thumbnail,
          photo.width,
          photo.height,
          photo.data.length,
        );
      return this.readPhotoDraftFrom(tx, chatId);
    });
  }
  removePhotoDraft(chatId: string, id: number) {
    return this.transaction(async (tx) => {
      await tx.runAsync(
        "DELETE FROM draft_photos WHERE chat_key = ? AND id = ?",
        chatId,
        id,
      );
      return this.readPhotoDraftFrom(tx, chatId);
    });
  }

  readDraft(chatId: string): Promise<string> {
    return this.db.run((db) => this.readDraftFrom(db, chatId));
  }

  saveDraft(chatId: string, text: string): Promise<void> {
    return this.transaction(async (tx) => {
      if (!text) {
        await tx.runAsync("DELETE FROM drafts WHERE chat_key = ?", chatId);
        return;
      }
      // A delayed write must never resurrect a draft for a deleted conversation.
      await tx.runAsync(
        `INSERT INTO drafts (chat_key, text)
        SELECT ?, ? WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?)
        ON CONFLICT(chat_key) DO UPDATE SET text = excluded.text`,
        chatId,
        text,
        chatId,
      );
    });
  }

  // Opens a conversation with its retained draft, in one read.
  activate(id: string): Promise<Workspace> {
    return this.transaction((tx) => this.readWorkspace(tx, id));
  }

  // Opens the new chat, making one when the last became a saved chat.
  activateNew(): Promise<Workspace> {
    return this.transaction(async (tx) =>
      this.readWorkspace(tx, await this.newChatId(tx)),
    );
  }

  private async readWorkspace(db: Reader, id: string): Promise<Workspace> {
    return {
      ...(await this.readList(db)),
      chat: await this.readConversation(db, id),
      draft: {
        text: await this.readDraftFrom(db, id),
        photos: await this.readPhotoDraftFrom(db, id),
      },
    };
  }

  setSelectedModel(chatId: string, model: string): Promise<void> {
    return this.transaction(async (tx) => {
      const result = await tx.runAsync(
        "UPDATE chats SET selected_model = ? WHERE id = ?",
        model,
        chatId,
      );
      if (result.changes !== 1) throw new MissingChatError();
    });
  }

  // Deletion commits together with the new chat's workspace, which replaces
  // the deleted chat when it was the open one.
  remove(id: string): Promise<Workspace> {
    return this.transaction(async (tx) => {
      // Expo's exclusive transaction uses a separate connection, whose foreign
      // key pragma is independent. Delete dependent rows explicitly here.
      await tx.runAsync("DELETE FROM drafts WHERE chat_key = ?", id);
      await tx.runAsync("DELETE FROM draft_photos WHERE chat_key = ?", id);
      await tx.runAsync("DELETE FROM entries WHERE chat_id = ?", id);
      await tx.runAsync("DELETE FROM media WHERE chat_id = ?", id);
      await tx.runAsync("DELETE FROM chats WHERE id = ?", id);
      return this.readWorkspace(tx, await this.newChatId(tx));
    });
  }
}
