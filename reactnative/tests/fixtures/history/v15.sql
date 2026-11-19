-- Frozen chat history at schema version 15, the supported baseline, written by the upgrade chain from the version-12 fixture before that chain was retired. Do not regenerate.
CREATE TABLE chats (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL, selected_model TEXT);
INSERT INTO chats VALUES('chat-a','First chat',1700000000000,'picked/model');
INSERT INTO chats VALUES('chat-b','Second chat ✓',1700000100000,'openrouter/free');
INSERT INTO chats VALUES('d040f704c42df3fe7154f42b3a647daf','',0,'draft/model');
CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            text TEXT NOT NULL
          , status TEXT NOT NULL DEFAULT 'complete'
            CHECK (status IN ('complete', 'pending', 'failed', 'cancelled')), reply_to INTEGER REFERENCES messages(id), error TEXT, model TEXT, audio_data TEXT, audio_format TEXT, audio_metadata TEXT, audio_length INTEGER, elapsed_millis INTEGER);
INSERT INTO messages VALUES(1,'chat-a','user',unistr('Hello\u000athere'),'complete',NULL,NULL,NULL,'UklGRiQAAABXQVZF','wav','{"durationMillis":1200}',16,NULL);
INSERT INTO messages VALUES(2,'chat-a','assistant','Hi! ünïcode','complete',1,NULL,'vendor/model-a',NULL,NULL,NULL,NULL,2300);
INSERT INTO messages VALUES(3,'chat-b','user','Second question','complete',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(4,'chat-b','assistant','','failed',3,'Rate limited','',NULL,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(5,'chat-b','user','Interrupted','complete',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(6,'chat-b','assistant','partial','pending',5,NULL,'vendor/model-b',NULL,NULL,NULL,NULL,NULL);
CREATE TABLE drafts (chat_key TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL);
INSERT INTO drafts VALUES('d040f704c42df3fe7154f42b3a647daf',unistr('  new chat draft\u000a'));
INSERT INTO drafts VALUES('chat-a','follow-up draft');
CREATE TABLE photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            data TEXT NOT NULL, thumbnail TEXT NOT NULL,
            width INTEGER NOT NULL, height INTEGER NOT NULL,
            encoded_length INTEGER NOT NULL
          );
INSERT INTO photos VALUES(1,1,'/9j/4AAQSkZJRgABAQ==','/9j/thumb',640,480,20);
CREATE TABLE draft_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_key TEXT NOT NULL, data TEXT NOT NULL, thumbnail TEXT NOT NULL,
            width INTEGER NOT NULL, height INTEGER NOT NULL, encoded_length INTEGER NOT NULL
          );
INSERT INTO draft_photos VALUES(1,'chat-a','/9j/draftphoto','/9j/dthumb',100,200,14);
CREATE TABLE preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_model TEXT NOT NULL,
      speech_language TEXT
    );
INSERT INTO preferences VALUES(1,'kv/model',NULL);
INSERT INTO sqlite_sequence VALUES('messages',6);
INSERT INTO sqlite_sequence VALUES('photos',1);
INSERT INTO sqlite_sequence VALUES('draft_photos',1);
CREATE INDEX messages_by_chat ON messages(chat_id, id);
CREATE UNIQUE INDEX message_reply ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE UNIQUE INDEX pending_reply ON messages(chat_id) WHERE status = 'pending';
CREATE INDEX photos_by_message ON photos(message_id, id);
CREATE INDEX draft_photos_by_chat ON draft_photos(chat_key, id);
PRAGMA user_version = 15;
