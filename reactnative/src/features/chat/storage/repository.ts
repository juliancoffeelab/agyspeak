import type { SQLiteDatabase } from "expo-sqlite";

import type { HistoryRows } from "../../../migrations/index.ts";
import type { Connection, OrderedDatabase } from "../../../storage/database.ts";
import { selectContext, summarizeLevels } from "../runtime/context.ts";
import type {
  ReplyStatus,
  AudioMetadata,
  PhotoReference,
  PhotoInput,
  PhotoAttachment,
  Message,
  PromptMessage,
  ChatSummary,
  Turn,
} from "./contracts.ts";
import {
  MAX_MESSAGE_LENGTH,
  MissingChatError,
  summarizeDraft,
} from "./contracts.ts";
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
  "photos",
  "id" | "thumbnail" | "width" | "height" | "encoded_length"
>;
const toAttachment = (row: PhotoRow): PhotoAttachment => ({
  id: row.id,
  thumbnail: row.thumbnail,
  width: row.width,
  height: row.height,
  encodedLength: row.encoded_length,
});
const toPhotoInput = (
  row: Row<"photos", "data" | "thumbnail" | "width" | "height">,
): PhotoInput => ({
  data: row.data,
  thumbnail: row.thumbnail,
  width: row.width,
  height: row.height,
});

// One conversation as storage committed it.
export type Conversation = {
  id: string;
  messages: Message[];
  selectedModel: string | null;
};
// Results name the records they affect. `seq` orders results by when their
// operation ran, so a caller can reject a read older than one it applied.
export type ChatUpdate = {
  seq: number;
  chats: ChatSummary[];
  chat: Conversation;
};
export type NewChat = {
  id: string;
  selectedModel: string | null;
  draft: { text: string; photos: PhotoAttachment[] };
};
export type Workspace = ChatUpdate & {
  draft: { text: string; photos: PhotoAttachment[] };
};
export type TerminalOutcome = {
  status: Exclude<ReplyStatus, "pending">;
  text: string;
  error: string | null;
  // The model that answered, when the provider said; null keeps the one asked.
  model: string | null;
  elapsedMillis: number | null;
};

// The new chat is the chat with no messages yet. It is a row like any other,
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
        WHERE NOT EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id)
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

  // Runs after the database upgrade: applies the current contract to replies
  // the app closed before finishing.
  initialize() {
    return this.db.run(async (db) => {
      await db.runAsync(
        `UPDATE messages SET status = 'failed', error = ? WHERE status = 'pending'`,
        "The app closed before this reply finished.",
      );
    });
  }

  // What startup opens: the new chat's model choice and draft, without the
  // list of chats, which `readChats` reads separately.
  readNewChat(): Promise<NewChat> {
    return this.transaction(async (tx) => {
      const id = await this.newChatId(tx);
      return {
        id,
        selectedModel: (await this.readConversation(tx, id)).selectedModel,
        draft: {
          text: await this.readDraftFrom(tx, id),
          photos: await this.readPhotoDraftFrom(tx, id),
        },
      };
    });
  }

  // The new chat first, then the saved chats, newest first; ordered with
  // every update's list by `seq`.
  readChats(): Promise<{ seq: number; chats: ChatSummary[] }> {
    return this.db.run(async (db) => ({
      seq: ++this.sequence,
      chats: await this.readChatsFrom(db),
    }));
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
        EXISTS (SELECT 1 FROM messages WHERE chat_id = c.id) AS saved,
        COALESCE((SELECT NULLIF(text, '') FROM messages WHERE chat_id = c.id AND text != '' ORDER BY id DESC LIMIT 1), '') AS preview,
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
    return {
      id,
      messages: await this.readMessages(db, id),
      selectedModel: chat.selected_model,
    };
  }

  private async readUpdate(db: Reader, id: string): Promise<ChatUpdate> {
    return {
      seq: ++this.sequence,
      chats: await this.readChatsFrom(db),
      chat: await this.readConversation(db, id),
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

  private async readMessages(db: Reader, chatId: string): Promise<Message[]> {
    const rows = await db.getAllAsync<
      Row<
        "messages",
        | "id"
        | "role"
        | "text"
        | "status"
        | "reply_to"
        | "error"
        | "model"
        | "elapsed_millis"
        | "audio_format"
        | "audio_metadata"
        | "audio_length"
      >
    >(
      `SELECT id, role, text, status, reply_to, error, model, elapsed_millis,
        audio_format, audio_metadata, audio_length
        FROM messages WHERE chat_id = ? ORDER BY id`,
      chatId,
    );
    const photos = await db.getAllAsync<PhotoRow & Row<"photos", "message_id">>(
      `SELECT p.id, p.message_id, p.thumbnail, p.width, p.height, p.encoded_length
        FROM photos p JOIN messages m ON m.id = p.message_id
        WHERE m.chat_id = ? ORDER BY p.id`,
      chatId,
    );
    const byMessage = new Map<number, PhotoAttachment[]>();
    for (const photo of photos) {
      const group = byMessage.get(photo.message_id) ?? [];
      group.push(toAttachment(photo));
      byMessage.set(photo.message_id, group);
    }
    return rows.map((row) => {
      const message: Message = {
        id: row.id,
        role: row.role,
        text: row.text,
        status: row.status,
        replyTo: row.reply_to,
        error: row.error,
        model: row.model,
        elapsedMillis: row.elapsed_millis,
      };
      const attached = byMessage.get(row.id);
      if (attached) message.photos = attached;
      if (row.audio_length === null || !row.audio_format) return message;
      const metadata = row.audio_metadata
        ? (JSON.parse(row.audio_metadata) as Pick<
            AudioMetadata,
            "durationMillis" | "levels"
          >)
        : {};
      return {
        ...message,
        audio: {
          ...metadata,
          id: row.id,
          encodedLength: row.audio_length,
          format: row.audio_format,
        },
      };
    });
  }

  readContext(chatId: string): Promise<PromptMessage[]> {
    return this.db.run((db) => this.readContextFrom(db, chatId));
  }

  private async readContextFrom(
    db: Reader,
    chatId: string,
  ): Promise<PromptMessage[]> {
    const selected = selectContext(await this.readMessages(db, chatId));
    const ids = selected
      .filter((message) => message.audio)
      .map((message) => message.id);
    const rows =
      ids.length === 0
        ? []
        : await db.getAllAsync<Row<"messages", "id" | "audio_data">>(
            `SELECT id, audio_data FROM messages WHERE chat_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
            chatId,
            ...ids,
          );
    const recordings = new Map(rows.map((row) => [row.id, row.audio_data]));
    const photoIds = selected.flatMap(
      (message) => message.photos?.map((photo) => photo.id) ?? [],
    );
    const photoRows = photoIds.length
      ? await db.getAllAsync<Row<"photos", "id" | "data">>(
          `SELECT id, data FROM photos WHERE id IN (${photoIds.map(() => "?").join(",")})`,
          ...photoIds,
        )
      : [];
    const photoData = new Map(photoRows.map((row) => [row.id, row.data]));
    return selected.map(({ audio, photos, ...message }) => {
      const loadedPhotos = photos?.map((photo) => {
        const data = photoData.get(photo.id);
        if (!data)
          throw new Error("A photo is missing from this conversation.");
        return {
          data,
          thumbnail: photo.thumbnail,
          width: photo.width,
          height: photo.height,
        };
      });
      if (loadedPhotos?.length) return { ...message, photos: loadedPhotos };
      if (!audio) return message;
      const data = recordings.get(message.id);
      if (!data)
        throw new Error("A recording is missing from this conversation.");
      return { ...message, audio: { format: audio.format, data } };
    });
  }

  readPhoto(reference: PhotoReference): Promise<PhotoInput> {
    return this.db.run(async (db) => {
      const photo = await db.getFirstAsync<
        Row<
          "photos" | "draft_photos",
          "data" | "thumbnail" | "width" | "height"
        >
      >(
        `SELECT data, thumbnail, width, height FROM ${reference.draft ? "draft_photos" : "photos"} WHERE id = ?`,
        reference.id,
      );
      if (!photo) throw new Error("This photo is no longer available.");
      return toPhotoInput(photo);
    });
  }

  // Internal readers take the connection they run on; public wrappers queue.
  private async readPhotoDraftFrom(db: Reader, chatId: string) {
    const rows = await db.getAllAsync<
      Row<
        "draft_photos",
        "id" | "thumbnail" | "width" | "height" | "encoded_length"
      >
    >(
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
      return rows.map(toPhotoInput);
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
    if (text.length > MAX_MESSAGE_LENGTH)
      return Promise.reject(new Error("Draft exceeds the message limit"));
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
      ...(await this.readUpdate(db, id)),
      draft: {
        text: await this.readDraftFrom(db, id),
        photos: await this.readPhotoDraftFrom(db, id),
      },
    };
  }

  setSelectedModel(chatId: string, model: string) {
    return this.transaction(async (tx) => {
      const result = await tx.runAsync(
        "UPDATE chats SET selected_model = ? WHERE id = ?",
        model,
        chatId,
      );
      if (result.changes !== 1) throw new MissingChatError();
      return this.readUpdate(tx, chatId);
    });
  }

  // Accepts a user turn and its pending reply together. A chat's first turn
  // titles it and fixes the model it was sent with.
  beginReply(
    id: string,
    turn: Turn,
    model: string,
    now: number,
  ): Promise<ChatUpdate & { replyId: number }> {
    const audio = turn.kind === "audio" ? turn.audio : null;
    const photos = turn.kind === "text" ? turn.photos : [];
    const text = turn.kind === "text" ? turn.text : "Voice message";
    return this.transaction(async (tx) => {
      const first = !(await tx.getFirstAsync(
        "SELECT id FROM messages WHERE chat_id = ? LIMIT 1",
        id,
      ));
      const chat = first
        ? await tx.runAsync(
            "UPDATE chats SET updated_at = ?, title = ?, selected_model = ? WHERE id = ?",
            now,
            (text || "Photo message").replace(/\s+/g, " ").trim().slice(0, 70),
            model,
            id,
          )
        : await tx.runAsync(
            "UPDATE chats SET updated_at = ? WHERE id = ?",
            now,
            id,
          );
      if (chat.changes !== 1) throw new MissingChatError();
      if (photos.length)
        await tx.runAsync("DELETE FROM draft_photos WHERE chat_key = ?", id);
      if (!audio)
        await tx.runAsync("DELETE FROM drafts WHERE chat_key = ?", id);
      const user = await tx.runAsync(
        "INSERT INTO messages (chat_id, role, text, audio_data, audio_format, audio_metadata, audio_length) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        "user",
        text,
        audio?.data ?? null,
        audio?.format ?? null,
        audio
          ? JSON.stringify({
              durationMillis: audio.durationMillis,
              levels: audio.levels ? summarizeLevels(audio.levels) : undefined,
            })
          : null,
        audio?.data.length ?? null,
      );
      for (const photo of photos) {
        await tx.runAsync(
          "INSERT INTO photos (message_id, data, thumbnail, width, height, encoded_length) VALUES (?, ?, ?, ?, ?, ?)",
          user.lastInsertRowId,
          photo.data,
          photo.thumbnail,
          photo.width,
          photo.height,
          photo.data.length,
        );
      }
      const reply = await tx.runAsync(
        `INSERT INTO messages (chat_id, role, text, status, reply_to, model) VALUES (?, 'assistant', '', 'pending', ?, ?)`,
        id,
        user.lastInsertRowId,
        model,
      );
      return {
        ...(await this.readUpdate(tx, id)),
        replyId: reply.lastInsertRowId,
      };
    });
  }

  retryReply(replyId: number, model: string, now: number) {
    return this.transaction(async (tx) => {
      const reply = await tx.getFirstAsync<Row<"messages", "chat_id">>(
        "SELECT chat_id FROM messages WHERE id = ?",
        replyId,
      );
      const result = await tx.runAsync(
        `UPDATE messages SET status = 'pending', text = '', error = NULL, elapsed_millis = NULL, model = ?
        WHERE id = ? AND role = 'assistant' AND status IN ('failed', 'cancelled', 'complete')
        AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.chat_id = messages.chat_id AND newer.id > messages.id)`,
        model,
        replyId,
      );
      if (!reply || result.changes !== 1)
        throw new Error("Only the latest finished reply can be retried");
      await tx.runAsync(
        "UPDATE chats SET updated_at = ? WHERE id = ?",
        now,
        reply.chat_id,
      );
      return { ...(await this.readUpdate(tx, reply.chat_id)), replyId };
    });
  }

  // Applies a terminal result only while the reply is still pending. Null
  // means another outcome won, or the chat was deleted.
  finishReply(
    replyId: number,
    outcome: TerminalOutcome,
  ): Promise<ChatUpdate | null> {
    return this.transaction(async (tx) => {
      const reply = await tx.getFirstAsync<Row<"messages", "chat_id">>(
        "SELECT chat_id FROM messages WHERE id = ?",
        replyId,
      );
      const result = await tx.runAsync(
        `UPDATE messages SET status = ?, text = ?, error = ?, model = COALESCE(?, model), elapsed_millis = ? WHERE id = ? AND status = 'pending'`,
        outcome.status,
        outcome.text,
        outcome.error,
        outcome.model,
        outcome.elapsedMillis,
        replyId,
      );
      if (!reply || result.changes !== 1) return null;
      return this.readUpdate(tx, reply.chat_id);
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
      await tx.runAsync(
        "DELETE FROM photos WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)",
        id,
      );
      await tx.runAsync("DELETE FROM messages WHERE chat_id = ?", id);
      await tx.runAsync("DELETE FROM chats WHERE id = ?", id);
      return this.readWorkspace(tx, await this.newChatId(tx));
    });
  }
}
