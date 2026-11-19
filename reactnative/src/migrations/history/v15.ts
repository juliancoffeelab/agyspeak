import { z } from "zod";

// Version 15, the oldest supported version: a fresh database is created here,
// and older ones are unsupported. A chat with no messages and an empty title
// is a new chat nothing was sent in yet.
export const version = 15;

const text = z.string();
const integer = z.number().int();

// The rows each table holds at this version, as SQLite returns them.
export const rows = {
  chats: z.object({
    id: text,
    title: text,
    updated_at: integer,
    selected_model: text.nullable(),
  }),
  messages: z.object({
    id: integer,
    chat_id: text,
    role: z.enum(["user", "assistant"]),
    text,
    status: z.enum(["complete", "pending", "failed", "cancelled"]),
    reply_to: integer.nullable(),
    error: text.nullable(),
    model: text.nullable(),
    audio_data: text.nullable(),
    audio_format: text.nullable(),
    audio_metadata: text.nullable(),
    audio_length: integer.nullable(),
    elapsed_millis: integer.nullable(),
  }),
  // `chat_key` is a chat id.
  drafts: z.object({ chat_key: text, text }),
  photos: z.object({
    id: integer,
    message_id: integer,
    data: text,
    thumbnail: text,
    width: integer,
    height: integer,
    encoded_length: integer,
  }),
  draft_photos: z.object({
    id: integer,
    chat_key: text,
    data: text,
    thumbnail: text,
    width: integer,
    height: integer,
    encoded_length: integer,
  }),
  preferences: z.object({
    id: z.literal(1),
    default_model: text,
    speech_language: text.nullable(),
  }),
};
export type Rows = {
  [table in keyof typeof rows]: z.infer<(typeof rows)[table]>;
};

const schema = [
  `CREATE TABLE chats (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    selected_model TEXT
  )`,
  `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete'
      CHECK (status IN ('complete', 'pending', 'failed', 'cancelled')),
    reply_to INTEGER REFERENCES messages(id),
    error TEXT,
    model TEXT,
    audio_data TEXT,
    audio_format TEXT,
    audio_metadata TEXT,
    audio_length INTEGER,
    elapsed_millis INTEGER
  )`,
  "CREATE INDEX messages_by_chat ON messages(chat_id, id)",
  "CREATE UNIQUE INDEX message_reply ON messages(reply_to) WHERE reply_to IS NOT NULL",
  "CREATE UNIQUE INDEX pending_reply ON messages(chat_id) WHERE status = 'pending'",
  "CREATE TABLE drafts (chat_key TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL)",
  `CREATE TABLE photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    thumbnail TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    encoded_length INTEGER NOT NULL
  )`,
  "CREATE INDEX photos_by_message ON photos(message_id, id)",
  `CREATE TABLE draft_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key TEXT NOT NULL,
    data TEXT NOT NULL,
    thumbnail TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    encoded_length INTEGER NOT NULL
  )`,
  "CREATE INDEX draft_photos_by_chat ON draft_photos(chat_key, id)",
  `CREATE TABLE preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_model TEXT NOT NULL,
    speech_language TEXT
  )`,
];

export type Statement = { sql: string; params: (string | null)[] };

// The statements that create an empty database at this version. A new
// installation reads aloud in the system language, or the device's default
// voice when the system names none.
export function create(source: { systemLanguage: string | null }): Statement[] {
  const preferences: Rows["preferences"] = {
    id: 1,
    default_model: "openrouter/free",
    speech_language: source.systemLanguage,
  };
  return [
    ...schema.map((sql) => ({ sql, params: [] })),
    {
      sql: "INSERT INTO preferences (id, default_model, speech_language) VALUES (1, ?, ?)",
      params: [preferences.default_model, preferences.speech_language],
    },
  ];
}
