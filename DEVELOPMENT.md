# Development

## How it works

The agent runs from a dedicated `~/.cache/agyspeak/workspace/` directory, rather
than the repository or the directory where you launched AGSpeak. This keeps the
project out of its immediate workspace; existing file-access permissions still
apply.

Each turn runs `agy --print --output-format stream-json`, with `--conversation <id>`
after the first turn so context carries over. AGSpeak passes `--sandbox` to isolate
shell commands. Command approval still follows your existing Antigravity policy;
AGSpeak does not grant automatic command approval or change global settings.

Each audio turn includes the absolute
recording path and asks Gemini to open it with its native file-viewing tool. That
tool returns the WAV as native audio, so Gemini can hear pronunciation and prosody.

On the first turn of a new conversation a short preamble is prepended telling the
model it is a general multimodal assistant, how to open native audio, and that
language learning is a common use. Override it with `--system "..."` or drop it
with `--no-system`. Resumed conversations already carry it in their history.

Things learned the hard way:

- `agy --print` sends `@/path.wav` references as plain text. Its native file-viewing
  tool (`view_file`, named `read_file` in some toolsets) returns audio to the model.
  Every audio turn explicitly requests that tool, including in resumed sessions.
  No shell permission bypass or external transcription service is needed.
- The model knows your macOS username regardless of where recordings live: agy's
  own system prompt includes its home, scratch, and MCP directories. Hiding it
  would mean faking `$HOME`, which would break agy's auth and config.
- The `google-antigravity` Python SDK talks to the Gemini API directly and needs
  `GEMINI_API_KEY`, so it does not use the subscription. That is why this shells
  out to `agy` instead.

## Turn logs and blocked requests

Raw CLI output is saved for every turn under `~/.cache/agyspeak/turns/`, in
separate timestamped `.log` files. These preserve the JSON event stream and CLI
diagnostics before parsing, including partial turns, for investigating output
issues. The `init` event identifies the conversation. Logs stay local and are
kept until you delete them.

If Antigravity blocks a tool request and returns no answer, AGSpeak continues
the same conversation once, asking for an answer from existing context without
further tools. The denied operation stays blocked; the recording is not resent.

## Voice prompt conventions

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

The independent Expo/React Native app lives in `reactnative/`. Its current screen
is a minimal placeholder. It has no connection to the Python application or a
model provider. The native audio, file-storage, and secure-storage dependencies
are available for subsequent UI work.

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
