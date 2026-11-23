import { z } from "zod";

import * as v15 from "./v15.ts";

// Version 16: a chat is an append-only log of entries (its messages, the
// parts of its replies and its compactions), and the photos and recordings
// its messages hold are kept apart from it, by key.
export const version = 16;

const text = z.string();
const integer = z.number().int();
const count = integer.nonnegative();

// The JSON body of one entry, at this version.
const audio = z.strictObject({
  key: text,
  format: text,
  encodedLength: count,
  durationMillis: z.number().nonnegative().nullable(),
  levels: z.array(z.number()).nullable(),
});
const photo = z.strictObject({
  key: text,
  width: count,
  height: count,
  encodedLength: count,
});
const usage = z.strictObject({
  costUSD: z.number().nullable(),
  promptTokens: count.nullable(),
  completionTokens: count.nullable(),
  cachedPromptTokens: count.nullable(),
  cacheWritePromptTokens: count.nullable(),
});
// How a reply part ended short of complete, as a code: no sentence the
// app shows for it is saved.
const ending = z.enum([
  "stopped",
  "length",
  "reply-limit",
  "cut-off",
  "timeout",
  "empty",
  "no-compaction",
  "no-room",
  "too-small",
  "unsupported-input",
  "not-compacted",
  "request-failed",
  "provider-error",
  "closed",
]);
const range = z.strictObject({ entry: count, from: count, to: count });
export const entry = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    text,
    audio: audio.nullable(),
    photos: z.array(photo),
    postedAt: integer.nullable(),
  }),
  z.strictObject({
    kind: z.literal("reply"),
    status: z.enum(["complete", "cut", "stopped", "failed"]),
    text,
    ending: ending.nullable(),
    // The provider's own words on its error, on a `provider-error` part.
    providerMessage: text.nullable(),
    model: text.nullable(),
    usage: usage.nullable(),
    maxTokens: count.nullable(),
    compaction: count.nullable(),
    postedAt: integer.nullable(),
    elapsedMillis: count.nullable(),
  }),
  z.strictObject({
    kind: z.literal("compaction"),
    summary: z.strictObject({ text, tokens: count, model: text }),
    kept: z.array(z.array(range)),
    pass: z.enum(["final", "partial"]),
    instruction: text.nullable(),
  }),
]);

// The messages and photos tables are gone; the others are as they were.
export const rows = {
  chats: v15.rows.chats,
  drafts: v15.rows.drafts,
  draft_photos: v15.rows.draft_photos,
  preferences: v15.rows.preferences,
  // Entry `position` of chat `chat_id`, from 0; `body` is its JSON (see
  // `entry`).
  entries: z.object({ chat_id: text, position: count, body: text }),
  // A photo (with its thumbnail) or a recording (without one), as base64.
  // An entry names it by its `id`, as text.
  media: z.object({
    id: integer.positive(),
    chat_id: text,
    data: text,
    thumbnail: text.nullable(),
  }),
};
export type Rows = {
  [table in keyof typeof rows]: z.infer<(typeof rows)[table]>;
};

// The key a version-15 recording is given: after every photo's, which keep
// their ids.
const AUDIO_KEY = "(SELECT COALESCE(MAX(id), 0) FROM photos) + m.id";
const literal = (sentence: string) => `'${sentence.replaceAll("'", "''")}'`;
const among = (sentences: string[]) =>
  `m.error IN (${sentences.map(literal).join(", ")})`;
const like = (patterns: string[]) =>
  patterns.map((pattern) => `m.error GLOB ${literal(pattern)}`).join(" OR ");
const startsWith = (prefix: string) =>
  `substr(m.error, 1, ${prefix.length + 1}) = ${literal(`${prefix} `)}`;
// The sentences the app ever saved as a reply's error, as written then,
// by what they say happened. They are read here once, into the code of how
// the reply ended; nothing after this step reads a sentence.
const CLOSED = [
  "The app closed before this reply finished.",
  "The app closed before this reply finished. You can retry it.",
];
const STOPPED = [
  "Stopped.",
  "Stopped. You can retry this reply.",
  "Reply cancelled.",
  "Reply stopped.",
];
const TIMEOUT = [
  "Timed out.",
  "The request timed out.",
  "The request timed out. You can retry it.",
];
const EMPTY = [
  "The model returned no text.",
  "The model returned no text. You can retry or choose another model.",
  "The model wrote nothing.",
];
// A compaction that failed: the one a cut reply's continuation needed on a
// stopped reply, the one a message needed on a failed one.
const COMPACTION = [
  "Couldn’t compact this conversation. Retry the compaction to continue.",
  "Cut off: the conversation couldn’t be compacted.",
  "Couldn’t make room for that message.",
  "The conversation couldn’t be compacted: compact it again or choose another model.",
  "One message in this conversation is too large for this model to summarize. A model with a larger context window can continue it.",
  "The summary reached its length limit.",
  "The summary timed out.",
  "The model wrote an empty summary.",
];
const UNSUPPORTED_LIKE = [
  "Couldn’t verify * support for *. Refresh the model list *",
  "* doesn’t support * input. Choose an *",
];
// What the app said before the provider's own words, after a space, for an
// error the provider answered with; the last is the undo's.
const PROVIDER = [
  "OpenRouter rejected the key. Check it in Settings.",
  "OpenRouter reports insufficient credits for this model.",
  "The request was rate limited. Try again later.",
  "The model provider is rate limited. Try again later.",
  "No provider is available for this model right now. Try again later.",
  "OpenRouter answered with an error.",
];
const HTTP = "OpenRouter request failed (HTTP [0-9]*).";
// How a reply ended, from its status and error. A complete one that wrote
// nothing ended empty, a pending one the app closed on, and a known
// sentence is its code. A provider's error is one in a shape the provider's
// errors were saved in, on a failed reply. Any other error is the app's:
// a stopped reply's says it stopped, a failed one's that its request failed.
const ENDING = `CASE
  WHEN m.status = 'complete' THEN CASE WHEN m.text = '' THEN 'empty' END
  WHEN m.status = 'pending' OR ${among(CLOSED)} THEN 'closed'
  WHEN m.error IS NULL THEN
    CASE m.status WHEN 'cancelled' THEN 'stopped' ELSE 'request-failed' END
  WHEN ${among(STOPPED)} THEN 'stopped'
  WHEN m.error = 'Reached the length limit.' THEN 'length'
  WHEN m.error = 'Cut off at this conversation’s length limit.' THEN 'cut-off'
  WHEN ${among(TIMEOUT)} THEN 'timeout'
  WHEN ${among(EMPTY)} THEN 'empty'
  WHEN ${among(COMPACTION)} THEN
    CASE m.status WHEN 'cancelled' THEN 'no-compaction' ELSE 'not-compacted' END
  WHEN m.error = 'That message doesn’t fit in what’s left of this conversation.'
    THEN 'no-room'
  WHEN m.error = 'This model’s context window is too small for a conversation.'
    THEN 'too-small'
  WHEN ${like(UNSUPPORTED_LIKE)} THEN 'unsupported-input'
  WHEN m.status = 'cancelled' THEN 'stopped'
  WHEN ${among(PROVIDER)} OR ${PROVIDER.map(startsWith).join(" OR ")}
    OR m.error GLOB ${literal(HTTP)} OR m.error GLOB ${literal(`${HTTP} *`)}
    THEN 'provider-error'
  ELSE 'request-failed' END`;
// The provider's own words on its error: what follows the app's sentence,
// null when nothing does.
const PROVIDER_MESSAGE = `CASE WHEN m.ending = 'provider-error' THEN CASE
  ${PROVIDER.map(
    (prefix) =>
      `WHEN ${startsWith(prefix)} THEN substr(m.error, ${prefix.length + 2})`,
  ).join("\n  ")}
  WHEN m.error GLOB ${literal(`${HTTP} *`)}
    THEN substr(m.error, instr(m.error, '). ') + 3)
  END END`;

// Each message becomes an entry, in order. A reply that says nothing (it
// failed, never finished, or wrote nothing) is dropped when anything follows
// it in its chat, its message kept unanswered; one that ends its chat is
// kept as failed, with what it wrote and why. A reply that wasn't finished
// failed because the app closed.
const ENTRIES = `
INSERT INTO entries (chat_id, position, body)
SELECT chat_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id) - 1, body
FROM (
  SELECT m.id, m.chat_id,
    CASE
      WHEN m.role = 'user' THEN json_object(
        'kind', 'user',
        'text', m.text,
        'audio', json(CASE WHEN m.audio_data IS NULL THEN 'null' ELSE json_object(
          'key', CAST(${AUDIO_KEY} AS TEXT),
          'format', m.audio_format,
          'encodedLength', COALESCE(m.audio_length, length(m.audio_data)),
          'durationMillis', json_extract(m.audio_metadata, '$.durationMillis'),
          'levels', json(COALESCE(json_extract(m.audio_metadata, '$.levels'), 'null'))
        ) END),
        'photos', json((SELECT json_group_array(json_object(
            'key', CAST(p.id AS TEXT),
            'width', p.width,
            'height', p.height,
            'encodedLength', p.encoded_length))
          FROM (SELECT * FROM photos WHERE message_id = m.id ORDER BY id) p)),
        'postedAt', NULL)
      ELSE json_object(
        'kind', 'reply',
        'status', CASE
          WHEN m.status IN ('failed', 'pending') OR m.text = '' THEN 'failed'
          WHEN m.status = 'cancelled' THEN 'stopped'
          ELSE 'complete' END,
        'text', m.text,
        'ending', m.ending,
        'providerMessage', ${PROVIDER_MESSAGE},
        'model', m.model,
        'usage', NULL,
        'maxTokens', NULL,
        'compaction', NULL,
        'postedAt', NULL,
        'elapsedMillis', m.elapsed_millis)
    END AS body
  FROM (SELECT m.*, ${ENDING} AS ending FROM messages m) m
  WHERE NOT (
    m.role = 'assistant'
    AND (m.status IN ('failed', 'pending') OR m.text = '')
    AND EXISTS (SELECT 1 FROM messages later
      WHERE later.chat_id = m.chat_id AND later.id > m.id)
  )
)`;

export const upgrade: v15.Statement[] = [
  ...[
    `CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    thumbnail TEXT
  )`,
    "CREATE INDEX media_by_chat ON media(chat_id, id)",
    `CREATE TABLE entries (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    body TEXT NOT NULL CHECK (json_valid(body)),
    PRIMARY KEY (chat_id, position)
  )`,
    // A photo whose message is gone has no chat: the upgrade fails on it
    // rather than drop it.
    `INSERT INTO media (id, chat_id, data, thumbnail)
    SELECT p.id, m.chat_id, p.data, p.thumbnail
    FROM photos p LEFT JOIN messages m ON m.id = p.message_id ORDER BY p.id`,
    `INSERT INTO media (id, chat_id, data, thumbnail)
    SELECT ${AUDIO_KEY}, m.chat_id, m.audio_data, NULL
    FROM messages m WHERE m.audio_data IS NOT NULL ORDER BY m.id`,
  ].map((sql) => ({ sql, params: [] })),
  { sql: ENTRIES, params: [] },
  ...["DROP TABLE photos", "DROP TABLE messages"].map((sql) => ({
    sql,
    params: [],
  })),
];
