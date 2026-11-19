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
