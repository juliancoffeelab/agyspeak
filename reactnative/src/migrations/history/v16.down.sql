-- Undo of the pending version 16, for development only: takes a database at
-- version 16 back to the version 15 schema, exactly as version 15 creates it,
-- for a dev database stranded by a rewrite of the pending step. The app never
-- loads it. Run it with `sqlite3 -bail`: without -bail the command line tool
-- goes on after a failed statement and commits the rest.
--
-- It is lossy. What doesn't come back:
-- - compaction entries are dropped: their chats come back uncompacted, every
--   message still there;
-- - the parts of a cut reply are joined into one message, with the status,
--   error and model of its last part and the sum of their elapsed times;
-- - a reply's ending comes back as a sentence the app saved for it before
--   version 16, but for two the upgrade reads back as others: the reply's
--   whole limit is "Reached the length limit." (`length`), and a model
--   that can't take the conversation's media "The request failed."
--   (`request-failed`). A provider's error is "OpenRouter answered with an
--   error.", then the provider's message, if any;
-- - a failed reply the upgrade dropped stays dropped;
-- - what version 15 has no column for: a reply's usage, output limit and
--   compaction, and the times messages and replies were posted.
-- Messages are renumbered in their chats' order and photos in their
-- messages' order; references follow them. Everything else version 15 holds
-- comes back as version 16's upgrade carried it forward.
-- A chat that had been compacted comes back uncompacted, its continued
-- replies as single messages, which at a small limit can be larger than a
-- compaction request, leaving that chat unable to compact.

PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- Each message entry, with the position of the message it belongs to: a
-- user entry its own, a reply part the latest user entry before it.
CREATE TEMP TABLE down_parts AS
SELECT chat_id, chat_order, position, kind, body, asked,
  ROW_NUMBER() OVER whole AS step,
  SUM(json_extract(body, '$.elapsedMillis')) OVER whole AS spent
FROM (
  SELECT e.chat_id, c.rowid AS chat_order, e.position,
    json_extract(e.body, '$.kind') AS kind, e.body,
    MAX(CASE WHEN json_extract(e.body, '$.kind') = 'user' THEN e.position END)
      OVER (PARTITION BY e.chat_id ORDER BY e.position) AS asked
  FROM entries e JOIN chats c ON c.id = e.chat_id
  WHERE json_extract(e.body, '$.kind') <> 'compaction'
)
WINDOW whole AS (PARTITION BY chat_id, asked, kind ORDER BY position
  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING);

-- Each reply's text: its parts' joined in order. (A windowed group_concat
-- of empty texts gives a NUL character rather than an empty text.)
CREATE TEMP TABLE down_texts AS
WITH RECURSIVE joined (chat_id, asked, step, text) AS (
  SELECT chat_id, asked, step, json_extract(body, '$.text')
  FROM down_parts WHERE kind = 'reply' AND step = 1
  UNION ALL
  SELECT p.chat_id, p.asked, p.step, j.text || json_extract(p.body, '$.text')
  FROM joined j JOIN down_parts p ON p.chat_id = j.chat_id
    AND p.asked IS j.asked AND p.kind = 'reply' AND p.step = j.step + 1
)
SELECT chat_id, asked, text FROM joined j
WHERE NOT EXISTS (SELECT 1 FROM down_parts p WHERE p.chat_id = j.chat_id
  AND p.asked IS j.asked AND p.kind = 'reply' AND p.step = j.step + 1);

-- The version-15 messages: each user entry, and each reply's parts as one,
-- numbered in order.
CREATE TEMP TABLE down_messages AS
SELECT ROW_NUMBER() OVER (ORDER BY chat_order, first) AS id,
  chat_id, asked, role, first, last
FROM (
  SELECT chat_id, chat_order, asked, 'user' AS role,
    position AS first, position AS last
  FROM down_parts WHERE kind = 'user'
  UNION ALL
  SELECT chat_id, chat_order, asked, 'assistant', MIN(position), MAX(position)
  FROM down_parts WHERE kind = 'reply' GROUP BY chat_id, asked
);

-- Fails the script on media an entry names but the database doesn't hold.
CREATE TEMP TABLE down_missing (key TEXT CHECK (key IS NULL));
INSERT INTO down_missing
SELECT json_extract(body, '$.audio.key') FROM down_parts
WHERE json_extract(body, '$.audio.key') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM media
    WHERE id = CAST(json_extract(body, '$.audio.key') AS INTEGER))
UNION ALL
SELECT json_extract(photo.value, '$.key')
FROM down_parts, json_each(down_parts.body, '$.photos') AS photo
WHERE NOT EXISTS (SELECT 1 FROM media
  WHERE id = CAST(json_extract(photo.value, '$.key') AS INTEGER)
    AND thumbnail IS NOT NULL);

CREATE TABLE messages (
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
  );
CREATE INDEX messages_by_chat ON messages(chat_id, id);
CREATE UNIQUE INDEX message_reply ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE UNIQUE INDEX pending_reply ON messages(chat_id) WHERE status = 'pending';
CREATE TABLE photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    thumbnail TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    encoded_length INTEGER NOT NULL
  );
CREATE INDEX photos_by_message ON photos(message_id, id);

-- A recording's metadata as version 15 wrote it: its duration, then its
-- levels when it has them.
INSERT INTO messages (id, chat_id, role, text, status, reply_to, error, model,
  audio_data, audio_format, audio_metadata, audio_length, elapsed_millis)
SELECT m.id, m.chat_id, 'user', json_extract(p.body, '$.text'), 'complete',
  NULL, NULL, NULL,
  media.data,
  json_extract(p.body, '$.audio.format'),
  CASE
    WHEN json_type(p.body, '$.audio') <> 'object' THEN NULL
    WHEN json_type(p.body, '$.audio.levels') = 'array' THEN json_object(
      'durationMillis', json_extract(p.body, '$.audio.durationMillis'),
      'levels', json(json_extract(p.body, '$.audio.levels')))
    ELSE json_object(
      'durationMillis', json_extract(p.body, '$.audio.durationMillis'))
  END,
  json_extract(p.body, '$.audio.encodedLength'),
  NULL
FROM down_messages m
JOIN down_parts p ON p.chat_id = m.chat_id AND p.position = m.first
LEFT JOIN media
  ON media.id = CAST(json_extract(p.body, '$.audio.key') AS INTEGER)
WHERE m.role = 'user';

-- A reply's status and error, mapped back from its last part's status and
-- ending as version 16's upgrade mapped them forward, the error a sentence
-- the app saved for it: a stopped or cut reply was cancelled; a failed one
-- that ended empty was complete; one that ended stopped, at a limit, timed
-- out or without the compaction its continuation needed was cancelled; one
-- the app closed on that ends its chat was still pending; any other failed.
INSERT INTO messages (id, chat_id, role, text, status, reply_to, error, model,
  audio_data, audio_format, audio_metadata, audio_length, elapsed_millis)
SELECT id, chat_id, 'assistant', joined, status, reply_to,
  CASE
    WHEN status IN ('complete', 'pending') THEN NULL
    WHEN ending = 'stopped' THEN 'Stopped.'
    WHEN ending IN ('length', 'reply-limit') THEN 'Reached the length limit.'
    WHEN ending = 'cut-off' THEN 'Cut off at this conversation’s length limit.'
    WHEN ending = 'timeout' THEN 'Timed out.'
    WHEN ending = 'no-compaction'
      THEN 'Cut off: the conversation couldn’t be compacted.'
    WHEN ending = 'no-room'
      THEN 'That message doesn’t fit in what’s left of this conversation.'
    WHEN ending = 'too-small'
      THEN 'This model’s context window is too small for a conversation.'
    WHEN ending = 'not-compacted' THEN 'Couldn’t make room for that message.'
    WHEN ending = 'closed' THEN 'The app closed before this reply finished.'
    WHEN ending = 'provider-error' THEN 'OpenRouter answered with an error.'
      || COALESCE(' ' || provider_message, '')
    ELSE 'The request failed.'
  END,
  model, NULL, NULL, NULL, NULL, spent
FROM (
  SELECT m.id, m.chat_id, t.text AS joined, l.spent, u.id AS reply_to,
    json_extract(l.body, '$.ending') AS ending,
    json_extract(l.body, '$.providerMessage') AS provider_message,
    json_extract(l.body, '$.model') AS model,
    CASE json_extract(l.body, '$.status')
      WHEN 'complete' THEN 'complete'
      WHEN 'stopped' THEN 'cancelled'
      WHEN 'cut' THEN 'cancelled'
      ELSE CASE
        WHEN json_extract(l.body, '$.ending') = 'empty' THEN 'complete'
        WHEN json_extract(l.body, '$.ending')
            IN ('stopped', 'length', 'reply-limit', 'cut-off', 'timeout',
              'no-compaction')
          THEN 'cancelled'
        WHEN json_extract(l.body, '$.ending') = 'closed'
          AND NOT EXISTS (SELECT 1 FROM down_parts later
            WHERE later.chat_id = m.chat_id AND later.position > m.last)
          THEN 'pending'
        ELSE 'failed' END
    END AS status
  FROM down_messages m
  JOIN down_parts l ON l.chat_id = m.chat_id AND l.position = m.last
  JOIN down_texts t ON t.chat_id = m.chat_id AND t.asked IS m.asked
  LEFT JOIN down_messages u
    ON u.chat_id = m.chat_id AND u.role = 'user' AND u.first = m.asked
  WHERE m.role = 'assistant'
);

INSERT INTO photos (id, message_id, data, thumbnail, width, height,
  encoded_length)
SELECT ROW_NUMBER() OVER (ORDER BY m.id, photo.key), m.id,
  media.data, media.thumbnail,
  json_extract(photo.value, '$.width'),
  json_extract(photo.value, '$.height'),
  json_extract(photo.value, '$.encodedLength')
FROM down_messages m
JOIN down_parts p ON p.chat_id = m.chat_id AND p.position = m.first
JOIN json_each(p.body, '$.photos') AS photo
JOIN media ON media.id = CAST(json_extract(photo.value, '$.key') AS INTEGER)
WHERE m.role = 'user';

DROP TABLE down_missing;
DROP TABLE down_messages;
DROP TABLE down_texts;
DROP TABLE down_parts;
DROP TABLE entries;
DROP TABLE media;
PRAGMA user_version = 15;
COMMIT;
