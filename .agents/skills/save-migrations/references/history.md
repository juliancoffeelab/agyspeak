# Chat history versions

One section per version of `chat-history.db`: what its step changed, kept and
dropped. Read a section when changing or investigating that version; add one
with each new step.

## Version 15: baseline

The oldest supported version. `reactnative/src/migrations/history/v15.ts` holds
its full schema and creates an empty database; anything older is rejected
unchanged.

A chat with no messages and an empty title is a new chat nothing was sent in
yet. Its draft text, draft photos and chosen model are stored under its id like
any other chat's. `drafts.chat_key` and `draft_photos.chat_key` are always chat
ids.

The steps from version 12 were removed on the branch that introduced this
baseline, after every installation had opened a version-15 build. They dropped
`app_state.active_chat_id` (13) and `app_state.last_sent_chat_id` (14), then
moved the unsent new chat's draft, photos and model from the empty key and
`app_state.draft_model` to a chat row and dropped `app_state` (15).

The frozen fixture, `reactnative/tests/fixtures/history/v15.sql`, was written by
those steps from the version-12 fixture. Its chat
`d040f704c42df3fe7154f42b3a647daf` is the new chat they created, holding a
draft and a chosen model.

## Version 16: chats as logs of entries

`reactnative/src/migrations/history/v16.ts` replaces `messages` and `photos`
with two tables, `entries` and `media`; `chats`, `drafts`, `draft_photos` and
`preferences` are unchanged.

- `entries`: a chat's log, one row per entry at `position` 0, 1, 2… of
  `chat_id` (referencing `chats`). `body` is the entry as JSON, of the shape
  `entry` in the module declares: a user message, one request's part of a
  reply, or a compaction (a summary, the ranges of earlier entries given word
  for word after it, and the instruction that continues a reply it cut).
  A part saves how it ended short of complete as one code, `ending`, and no
  sentence the app shows for it; `providerMessage` holds only the provider's
  own words on a `provider-error` part. Why a reply failed beyond that lives
  in memory, and a chat opened failed has no details.
  Replies and messages carry no ids; compactions and parts refer to entries by
  position, so entries are only appended or truncated, never moved.
- `media`: the bytes of a photo (with its `thumbnail`) or a recording (with a
  null one), by `id`, for `chat_id`. An entry names one by its `id` as text in
  its `key`. Media no entry names is garbage and is deleted at startup.

The step converts every version-15 message, in `id` order per chat:

- A user message becomes a user entry with its text, recording and photos.
  Photos keep their `id` as their key; a recording's key is its message `id`
  plus the highest photo `id`. `levels` and `durationMillis` come from
  `audio_metadata`, null when it held none. `postedAt` is null.
- A reply that says nothing (status `failed` or `pending`, or empty text) is
  dropped when any message follows it in its chat; its user message is kept,
  unanswered, so a version-16 log may hold a user entry followed by another.
  One that ends its chat becomes a `failed` part with its text.
- A `complete` reply becomes a `complete` part, and a `cancelled` one with
  text a `stopped` part.
- Versions 15 and before saved a sentence as a reply's error; the step
  reads it once into the part's `ending`, and nothing after it reads one.
  `v16.ts` lists every sentence the app saved, found in the repository's
  history, by its code. An empty `complete` reply ended `empty`, and a
  `pending` one `closed`. A `cancelled` reply with no error ended `stopped`,
  and a `failed` one `request-failed`. Sentences for stopping, the length
  limit, the conversation's cut-off, timing out, writing nothing, the app
  closing, no room, a context too small, and a model's missing photo or
  audio support map to `stopped`, `length`, `cut-off`, `timeout`, `empty`,
  `closed`, `no-room`, `too-small` and `unsupported-input`. A failed
  compaction's sentence maps to `no-compaction` on a `cancelled` reply and
  `not-compacted` on a `failed` one.
- A `cancelled` reply is never a provider's error. On a `failed` reply, an
  error that starts with the app's sentence for an HTTP status ("OpenRouter
  request failed (HTTP n).", the key, credits, rate-limit or no-provider
  sentences, or the undo's "OpenRouter answered with an error.") is
  `provider-error`. Its `providerMessage` is what
  follows that sentence after a space, or null when nothing does.
- Any other error is taken as the app's own wording and dropped, a
  declared loss: a `cancelled` reply's becomes `stopped`, a `failed` one's
  `request-failed`, and its text is kept nowhere.
- Replies keep `model` and `elapsed_millis`; `usage`, `maxTokens`,
  `compaction` and `postedAt` are null, since version 15 kept none of them.
- A photo whose message is missing fails the step rather than being dropped.

Version 15 held no summaries, so no compaction entries are made.

Undo: `reactnative/src/migrations/history/v16.down.sql` takes a version-16
database back to version 15, for development only, while the version is
pending. It is plain SQL run with `sqlite3 -bail`; the app never loads it.
`messages` and `photos` are recreated as version 15 creates them, messages
renumbered in their chats' order and photos in their messages', and the
status and ending map back to the status and sentence version 15 saved, as
the step above maps them forward. It is lossy:

- compaction entries are dropped, and their chats come back uncompacted with
  every message;
- a cut reply's parts are joined into one message, with the last part's
  status, error and model and the sum of the parts' elapsed times;
- a failed reply the step dropped stays dropped;
- an ending comes back as a sentence the step reads back to it, but for
  two: the reply's whole limit comes back as "Reached the length limit."
  (`length`), and a model's missing media support as "The request
  failed." (`request-failed`). A provider's error comes back as
  "OpenRouter answered with an error.", then the provider's message if
  there is one, which the step reads back as the same error;
- usage, `maxTokens`, `compaction` and `postedAt` are lost, since version 15
  has no columns for them.

A chat that had been compacted comes back uncompacted with its continued
replies as single messages, which at a small limit can be larger than a
compaction request, leaving that chat unable to compact.

`tests/migrations.test.mjs` runs it on the upgraded baseline and on a log
the app wrote, so it stays current with the pending step.
