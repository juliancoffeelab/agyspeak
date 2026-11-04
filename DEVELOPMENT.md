# Development

## How it works

The agent runs from a dedicated `~/.cache/agyspeak/workspace/` directory, rather
than the repository or the directory where you launched AGSpeak. This keeps the
project out of its immediate workspace; existing file-access permissions still
apply.

AGSpeak runs Google's official `antigravity-acp` runtime as one persistent
JSON-RPC subprocess. It no longer wraps `agy --print`. ACP sessions preserve
context across turns; `/new` starts a fresh session and `--conversation <id>` or
`-c` resumes a saved session. A failed resume is reported rather than silently
starting an empty conversation. Older CLI conversation IDs may not be loadable
by the ACP runtime; start a new conversation if it rejects an old ID.

## ACP runtime and authentication

Install the pinned official runtime (currently 1.4.5) from the repository root:

```sh
uv run python -m agyspeak.acp_runtime
```

The installer downloads from Google's CDN, verifies the ACP Registry SHA-256,
and keeps both `agy_acp_server.par` and its required sibling
`localharness_external` under
`~/.local/share/agyspeak/antigravity-acp/1.4.5/`. It does not authenticate or make
inference requests. Alternatively, put `agy_acp_server.par` on PATH or set
`AGYSPEAK_ACP_BINARY` to the executable from a complete official distribution.

The first message or `/models` may open the runtime's own browser sign-in flow
using `oauth-personal`. ACP keeps its own authentication; AGSpeak does not read
or copy CLI credentials. No API key is needed for this personal-account flow.

`/models` lists the runtime's actual model catalog without submitting a prompt.
`/model <id>` selects from that catalog. The default is `gemini-3.8-flash`.
The default thinking level is `medium`; `--effort low|medium|high` overrides the
separate ACP thinking-level selector. `/model` reports the model and thinking
level together. `/effort` reports the current level; `/effort low|medium|high`
changes it for the next message without starting a new conversation. Saved
CLI model IDs such as `gemini-3.8-flash-medium` are mapped to the base model and
thinking level. Unavailable models are reported before a prompt is sent.
Model, effort, and conversation ID share one `SessionPreferences` representation.
Both the last-session file and session index preserve effort; explicit `--model`
and `--effort` options override saved settings on resume. Last-session writes use
an atomic replacement, so a failed write leaves the previous record intact.

The normal ACP mode is `default`. Permission requests are shown in the terminal
and require an explicit allow-once answer; noninteractive backend users reject
requests unless they supply a permission callback. `--yolo` explicitly selects
ACP's `yolo` mode and approves permission requests. AGSpeak does not advertise
client filesystem or terminal execution capabilities. The official runtime
executes its own tools and controls their sandbox; the old CLI `--sandbox` flag
is not forwarded to ACP.

## Native audio and prompts

When `initialize` advertises the audio prompt capability, AGSpeak sends the
recording as an ACP native audio block with its MIME type and base64 bytes.
Google's official 1.4.5 runtime advertises this capability. If a runtime does not
advertise audio, each turn instead includes the absolute recording path and
asks the agent to open it with its native file-viewing tool. There is no external
transcription service. Long WAVs retain the existing lossless splitting and
ordered multipart conversation flow.

On the first prompt of a new session a short preamble explains the multimodal
assistant role, language learning, and speech markup. Override it with
`--system "..."` or omit it with `--no-system`. Resumed sessions keep their
existing instructions. Native audio attachments do not require file tools.

## Turn logs and interruption

Incoming ACP JSON and separate stderr diagnostics are saved for each turn under
`~/.cache/agyspeak/turns/`, in timestamped `.log` files. They include thought and
tool events for diagnosis; only agent message chunks become the displayed and
spoken answer. All runtime stderr, including startup and `/models` diagnostics,
is also saved to `~/.cache/agyspeak/acp.log`. Raw diagnostics are never forwarded
to the terminal; authentication uses a separate, short sign-in notice. Runtime
exit errors point to the diagnostic log. Logs stay local until deleted. Prompts
and outgoing audio bytes are not written to these logs.

Permission denials are returned to the running agent so it can finish its turn.
AGSpeak does not submit an extra recovery prompt or automatically retry inference
errors. Timeout, interruption, malformed protocol output, or a failed event
callback shuts down the connection. A later turn reconnects and attempts to
resume the saved session.
Request deadlines cover sending audio bytes as well as waiting for responses.
An interrupted active prompt sends ACP `session/cancel` before closing stdin;
pending tool permission requests receive a cancelled outcome. If an upload was
only partially sent, the connection is closed without appending more JSON.
Exit cleanup first closes stdin to request an orderly shutdown and waits up to
two seconds for the entire process group, allowing children to finish saving
after their parent exits. If it stalls, the terminal asks whether to force stop,
with **No** (keep waiting) as the default. Declining waits another five seconds
before asking again. Only an explicit Yes sends SIGTERM and, if that fails to
stop the group within another second, SIGKILL. Approval is recorded in `acp.log`.
Backend users without a force-stop callback keep waiting; `--yolo` does not
authorize forced shutdown.
Output readers close their own pipes, so an inherited open pipe
cannot block the terminal's shutdown while another thread is reading it.
Connections explicitly track open, closing, and closed states. Interrupted
cleanup can be retried, and a closing connection is never reused. Library callers
own client lifetimes with `with AgyClient(...) as client:`; evaluation jobs each
close their own client. The terminal owns its chat client and speech service
through scoped cleanup rather than hidden interpreter-exit registrations.

## Backend boundaries

`acp.py` owns JSON-RPC transport, subprocess lifecycle, deadlines, and cancellation.
`backend.py` owns Antigravity authentication, session configuration, prompts, and
audio turns. It emits four application events from `events.py`: text deltas, tool
progress, audio-part progress, and sign-in requests. The terminal renders these
events without depending on ACP wire fields or the removed print-mode stream.
`sessions.py` holds session preferences and atomic last-session writes.

The client intentionally supports one request at a time and stays specific to
Antigravity. A provider framework and concurrent-session orchestration are out
of scope.

The focused backend tests use a local fake ACP subprocess. They exercise
streaming, permissions, native audio, fallback paths, resumption, authentication
messages, model selection, and process cleanup without provider requests:

```sh
uv run pytest tests/test_acp.py tests/test_backend.py tests/test_acp_runtime.py tests/test_cli.py tests/test_sessions.py tests/test_audio.py
```

## Voice prompt conventions

The default English Kokoro voice is **Fable** (`bm_fable`, British English).
`/voice <id>` selects and saves another voice; a saved selection takes precedence
over the built-in default on startup.

Automatic voice replies consume ACP text deltas while the response is generated.
`StreamingSpeech` retains Markdown context and releases complete paragraphs or
closed standalone speech scopes; the unfinished tail is flushed at turn end.
Code fences remain excluded, and `<speak>` blocks retain their voice settings
and poem line breaks. Multipart audio acknowledgements are internal and are not
sent to narration.

Each reply owns one `NarrationStream` in the speech service. New text appends to
the same job, allowing synthesis and playback to overlap model generation and
each other. Live narration plays the first synthesized segment immediately;
complete-script playback retains its existing startup buffer. One combined WAV
and its metadata are saved for the reply. Stopping, replacing, or unloading speech
cancels the stream and rejects later appends, so arriving model text cannot
restart it. Model errors cancel partial narration; local speech errors do not
abort the model turn. `/repeat` still narrates the complete last reply.

For bilingual English/Swedish replies, Gemini wraps Swedish passages in
`<speak language="sv">...</speak>`. Voice mode uses the vendored Swedish Kokoro
voice **Klara**, then returns to your selected English voice. Swedish model
weights download on first use. Swedish text keeps its native letter names;
for example, `<speak language="sv">bokstaven S</speak>`. Use ordinary Swedish
spelling inside the tags, and IPA in English explanations for individual sounds.
The updated preamble applies to new conversations (`/new`); resumed chats keep
their existing instructions.

## MCP playback

Kokoro/Qwen playback and replay use the running `agyspeak` process. macOS `say`
can run directly.

## Vendored Swedish Kokoro

The Swedish Kokoro runtime is in [`vendor/kokoro-sv`](vendor/kokoro-sv).
uv installs it as an editable workspace dependency, so Python edits there take
effect directly. The copy includes our pronunciation phrasing patch; model
weights and lexicons stay in Hugging Face's download cache.

See [`VENDORED.md`](vendor/kokoro-sv/VENDORED.md) for the upstream revision,
license, local changes, and focused checks. The harness routes Swedish speech
to this vendored engine.

## Scoped speech in replies

Use the same options as the `speak` tool inside a scoped block:

```xml
English explanation. <speak language="sv" voice="Lars" speed="0.9">
Ringarnas härskare

Text to read in Swedish.
</speak> Back to English.
```

The terminal hides the tags and renders their contents as normal Markdown;
code examples remain literal. Attributes are `voice`, `language`, `speed`
(0.5–1.5), `engine`, and `instruct` (Qwen only). Nested scopes inherit options
and restore the enclosing options when closed. Swedish voice names select
`kokoro-sv` automatically; Swedish without a named voice uses Klara.
`<swedish>…</swedish>` remains supported. Use `engine="say" voice="Alva"`
for macOS speech.

Explicit `<speak>` blocks preserve line breaks for the vendored Swedish phrasing
patch. They stay together until the model context requires splitting, without
inserting extra silence. Swedish synthesis uses MPS on Apple Silicon, CUDA when
available elsewhere, and CPU otherwise. Restart the harness and use `/new` to
load the updated Gemini prompt.

## Android foundation

The independent Expo/React Native app lives in `reactnative/`. It uses OpenRouter directly, with
API keys in device secure storage and conversations in SQLite. It is independent
of the Python application's ACP runtime.

The shared header keeps New chat (square with pen), History (folder) and Settings icons in fixed
positions on chat and history screens. The History icon toggles that view.
Settings replaces those actions with a Close icon in the Settings position;
closing returns to the screen that opened it. The key scanner uses
the same close position and returns to Settings.

Settings groups model selection above OpenRouter credentials and spending.
`ModelPicker` owns search, dismissal, and model autosave; `OpenRouterSection`
owns key entry, confirmation, scanning, and spending. Selecting a suggestion,
leaving the model field, or closing Settings commits the model immediately.
Save is a text action beside Paste key, Scan QR, and Restore; it saves only the
API key and leaves Settings open. Restore discards key edits and validation
errors, restoring the saved key without writing storage. It is disabled when
there is no saved key, no draft change or error to discard, or a save is pending. Changing an existing key uses React Native's
cross-platform native alert with Keep current key / Replace key actions.
Keeping the current key (or dismissing the alert) restores the saved key in the
field. Removing a saved key has a corresponding Remove key confirmation.
First-time key entry and unchanged keys do not need confirmation.

Only the API key is stored in SecureStore. The selected model uses Expo SQLite's
cross-platform key-value preferences. Startup migration copies the previous
combined record into those separate destinations, favoring existing new-format
values, and deletes the old record only after both writes succeed. Interrupted
migration can retry without losing either value. Preference writes are queued
so rapid model selections persist in order.
The model picker searches a compact, on-device catalog from `GET /models`;
the first visit downloads it, later visits use the saved file, and the refresh
icon replaces it explicitly. Audio support comes from the catalog's input
modalities. Suggestions show cached input/output token prices per million
tokens. Tapping outside the picker or finishing keyboard input dismisses its
suggestions and keeps the entered model ID; blank input falls back to
`openrouter/free` and autosaves that selection. Custom model IDs remain accepted. Catalog refresh failures retain
the existing list. Catalog storage validates a versioned list of normalized
`RouterModel` records and migrates the earlier provider-shaped cache locally.
No catalog data is added to secure key storage.

Spending uses `GET /key` for daily/monthly usage and the key's remaining cap.
`GET /credits` is attempted with the same key: if allowed, the remaining account
balance replaces the key allowance and is labeled accordingly. If that endpoint
is unavailable, an uncapped key shows “No cap”, never an invented wallet balance.
TanStack Query owns metadata requests, cancellation, and in-memory caching.
Spending always uses the saved key. Typing, Paste, Scan, and leaving the field
only edit its draft; they leave the current stats visible and make no requests
for the replacement. The spending query switches keys only after a confirmed
save succeeds. Empty or malformed saved keys issue no requests.
The spending hook exposes empty, invalid, loading, error, and ready
states in the same fixed layout. Rejected credentials (401/403 from `GET /key`)
produce the invalid-key state and hide cached stats; a failed account-credits
permission check still falls back to key allowance. Network failures retain the
last successful stats. Spending stays fresh for 30 seconds and retains its last successful values while
refreshing or after a refresh failure; it is isolated per API key and never
persisted. Only the public model catalog is written to disk. Loading indicators
replace the refresh icons, and error feedback uses existing fixed-height slots,
so loading and refreshes do not insert rows into the form. Settings cannot open
until saved credentials/model preferences have finished loading.
Keyboard visibility is a shared `useSyncExternalStore` subscription. The Settings
modal drops the bottom safe-area inset while typing
so its scroll viewport meets the keyboard. Keyboard avoidance remains explicit
on both platforms. These metadata requests do not submit inference.

The composer owns its draft locally. Its uncontrolled native `TextInput` reports
edits into a ref; React state only tracks whether there is sendable text. Typing
does not update `App` or the message list. The input uses native font line
metrics instead of an explicit line height, keeping growing-field measurement
aligned with the Android editor. The input stays mounted during audio
capture, preserving draft text and native selection. Submitting clears it immediately; a failed save restores the original draft
only when no edits arrived in the meantime. Explicit chat navigation resets the
composer; creating the first saved turn does not remount it. Composer controls
use Lucide icons inside a shared rounded surface. Keyboard avoidance is explicit on both
platforms. The bottom safe-area inset is omitted while the keyboard is visible,
so navigation-bar padding does not become a gap above the keyboard.

`RecordingSession` owns capture and unsent clips through idle, preparing,
recording, ready and sending states. `useRecording` adapts Expo's recorder and
file picker to that owner. Navigation, backgrounding, and unmount invalidate
pending permission/preparation work before it can start capture. Native operations
are serialized; failed submissions retain their clip for explicit retry.

The composer has a microphone beside the text field. Tap it to record; the
send arrow stops and sends, and × discards it. Recording stops at 120 seconds. Backgrounding the app stops capture
and keeps the clip ready to send manually. The + button opens Android's audio
file picker, including clips pushed to `/sdcard/Download/` with ADB. Files must be
under 8 MB.

Voice requests contain native audio attachments with no transcription prompt or
structured response format. Gemini returns an ordinary text reply. Original
recordings remain in SQLite for conversation context and retries, but display
snapshots contain only their reference, format, duration and saved level ticks.
New clips keep at most 32 peaks for the saved bubble. Context selection uses
stored sizes before fetching recording bytes, so opening a chat, rendering a
bubble, and saving a reply never load the raw audio. Schema migration preserves
existing recordings and adds their encoded lengths for lazy loading. Live capture shows a scrolling window of recent microphone levels that fills
the space beside the timer, without regrouping older samples. Saved audio
bubbles summarize the full recording; imported files without capture data use a plain audio indicator. These
are amplitude levels, not a frequency spectrogram. There is no automatic
transcription or spoken playback. Existing transcripts from older versions remain
as text because their original recordings were already removed.

Every request uses the selected model, including voice turns and text follow-ups
with audio context. Unsupported audio input is reported as a provider error; no
model is silently substituted. Gemini Flash uses low thinking effort. Requests
with audio context have a 1,024-token reply limit.
Context is bounded to recent history with 24,000 text characters and 12 MB of
encoded audio data (before base64 expansion). Text-only requests keep their
512-token limit. Deleting a chat removes its recordings and capture metadata.
No inference runs as part of `pnpm check`.

From `reactnative/`, run `pnpm install` and `pnpm check`. `pnpm android` builds
and launches the development app; `pnpm android:release --no-bundler` builds and
launches the standalone release. The wrapper uses the standard macOS Android SDK
location and Android Studio's bundled JDK unless overridden in the environment.
After native configuration changes, run `pnpm prebuild` before building again.

From the repository root, `make android` builds, installs, and opens the release
on the single authorized USB-connected phone, without a device picker or Metro.
The equivalent command inside `reactnative/` is `pnpm android:usb`. The command
checks the phone before building and pins installation to that device's serial;
no phone, an unauthorized phone, or multiple USB devices produces an error.

`make check` runs the Android app's ESLint and TypeScript checks; `make lint` runs
ESLint alone. Both lint errors and warnings fail the check, and `make android`
runs the checks before building or installing. Inside `reactnative/`, use
`pnpm lint:fix` for automatic fixes.

The ESLint 10 flat config uses `@eslint-react/eslint-plugin`, React's official
hooks plugin (including Compiler diagnostics), `eslint-plugin-import-x`, and
type-aware TypeScript checks for unhandled/misused promises, unsafe types, and
deprecated APIs. Import resolution includes Android/native file extensions.
Standalone Expo rules check environment access and DOM exports; the official
React Native plugin checks platform colors and deprecated deep imports. React
DOM and server-component rules are disabled for this native app. Compiler
diagnostics do not enable the compiler's build-time optimizations.

The old Expo preset and `eslint-plugin-react-native` are removed. Its unused-style
and single-element style-array checks are no longer available. A built-in syntax
guard catches literal text under common native containers; it does not cover
aliased containers or expression children. Generated native projects, artifacts,
and local secrets are excluded. These are offline source checks; native
dependency/build-tool deprecation warnings require separate maintenance.

`pnpm build:release` creates `artifacts/agyspeak-release.apk`. Its first run
generates a persistent local signing key under `.signing/`; keep a private backup
because updates require the same key. Signing files and build artifacts are
ignored by Git. Development uses package `dev.agyspeak.app.dev`; release uses
`dev.agyspeak.app`, so both builds can coexist.
