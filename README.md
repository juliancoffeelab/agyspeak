# agyspeak

Terminal chat with Gemini that lets you talk instead of type. It records your
microphone to a WAV file and hands it to the Antigravity CLI (`agy`), so it runs
on your Antigravity subscription with no API key.

## Requirements

- macOS with the `agy` CLI installed and logged in
- Python 3.14 and [uv](https://docs.astral.sh/uv/)

## Run

```sh
uv run agyspeak                      # default model gemini-3.7-flash-high
uv run agyspeak -m gemini-3.7-flash-low
uv run agyspeak -c                   # resume the last conversation
uv run agyspeak -l                   # list saved sessions
uv run agyspeak --conversation 2bbead17   # resume one by id (prefix is fine)
uv run agyspeak --yolo               # let agy run tools without asking
```

Inside the chat:

| input              | effect                                                   |
| ------------------ | -------------------------------------------------------- |
| plain text         | sent as a text message                                   |
| `/a` or empty Enter | record until Enter, then send right away                |
| `/rec`             | record until Enter, then ask for a note, then send       |
| `/a some note`     | record and send with the note attached                   |
| `/last [note]`     | re-send the most recent recording                        |
| `/model [name]`    | show or switch model, `/models` lists them               |
| `/new`             | start a fresh conversation                               |
| `/id`, `/devices`  | conversation id, input devices                           |
| `/sessions`        | list saved sessions                                      |
| `/help`, `/quit`   |                                                          |

Recordings are 16 kHz mono WAV under `~/.cache/agyspeak/recordings/`
(`latest.wav` points at the newest one). Sessions are registered in
`~/.cache/agyspeak/sessions.jsonl`; on exit the app prints how to resume the
current one.

## How it works

Each turn runs `agy --print --output-format stream-json`, with `--conversation <id>`
after the first turn so context carries over. Audio is attached by referencing the
file as `@/absolute/path.wav` in the prompt.

On the first turn of a new conversation a short preamble is prepended telling the
model it is a general multimodal assistant, that audio arrives as input, and that
language learning is a common use. Override it with `--system "..."` or drop it
with `--no-system`. Resumed conversations already carry it in their history.

Things learned the hard way:

- `agy` only attaches absolute `@/paths` that live under your home directory, and
  `--add-dir` does not change that. A path relative to its cwd works from anywhere.
  A file it refuses is silently ignored and the model tries to open it with tools.
- The model knows your macOS username regardless of where recordings live: agy's
  own system prompt includes its home, scratch, and MCP directories. Hiding it
  would mean faking `$HOME`, which would break agy's auth and config.
- Only the `gemini-3.7-flash-*` models actually receive the audio through `agy`.
  The `gemini-3.8-flash-*` models ignore the attachment and fall back to tools.
- The `google-antigravity` Python SDK talks to the Gemini API directly and needs
  `GEMINI_API_KEY`, so it does not use the subscription. That is why this shells
  out to `agy` instead.

## Letting Gemini talk back (optional)

`agyspeak-mcp` is a small MCP server that exposes a
`speak(text, voice="af_heart", speed=1.0, engine="auto", instruct=None,
language="auto")` tool. It synthesizes
with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an 82M-parameter local
TTS model that runs on CPU/MPS, and plays the result with `afplay`. Pass
`engine="say"` for the instant macOS voice instead. Once registered, Gemini calls
it when you ask to hear something ("say that", "read it back"), and stays quiet
otherwise. Kokoro has no emotion control; intonation comes from punctuation,
voice choice (a/b = American/British, f/m = female/male) and `speed`. Two voices
can be blended with `+`, e.g. `af_heart+bf_emma`.

A second tool, `narrate(lines=[{text, voice, speed}, ...], pause=0.4)`, plays a
whole multi-speaker script. Kokoro-only scripts start playing after the first
line renders, then render the rest during playback. A script containing Qwen
renders completely before playback so it has no pauses between lines. The MCP
tool still returns immediately. Gemini uses it for stories and dialogues; it
also costs one tool round-trip instead of one per line, which matters because
every round-trip resends the full conversation. `stop_speaking()` cuts off
whatever is playing while keeping loaded models warm. An in-flight render
finishes its current line silently before the worker starts another request.

A second engine, [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) 0.6B via
mlx-audio, is selected by using one of its speaker names as the voice (Ryan,
Vivian, Serena, Dylan, Eric, Aiden, Uncle_Fu, Ono_Anna, Sohee). It renders at
several times slower than playback on this machine, but takes a free-text
`instruct` ("whispering, conspiratorial", "barely holding back laughter") and
speaks ten languages. The 8-bit weights (~1 GB) download from `mlx-community`
on first use. Lines from both engines can be mixed in one `narrate` script. Use
Qwen for a few expressive lines and Kokoro for narration or long passages.

Speech requests go to a persistent local worker over a Unix socket. MCP calls
return immediately, and loaded Kokoro or Qwen models stay warm between calls.
Only one request runs at a time; a new request cancels the old one.
`unload_speech()` stops the worker and releases its model memory.

Kokoro needs `espeak-ng` for words outside its dictionary (`brew install
espeak-ng`). The model (~330 MB) downloads from Hugging Face on first use into
`~/.cache/huggingface/`. Generated speech is kept under
`~/.cache/agyspeak/speech/` as matching `speech_<id>.json` and `.wav` files.
The JSON records the text, voices, settings, status, and audio duration, so the
archive can be searched with tools such as `rg` or `jq`.

The MCP also exposes `list_audio(kind="all", limit=10)` and
`replay_audio(kind, audio_id="latest")`. They let the assistant discover and
replay microphone recordings or generated speech without receiving arbitrary
filesystem access.

```sh
agy mcp add agyspeak "$PWD/.venv/bin/agyspeak-mcp"
```

Headless `agy` cannot prompt for permission, so allow that one tool in
`~/.gemini/antigravity-cli/settings.json`:

```json
{ "permissions": { "allow": ["mcp(agyspeak/speak)", "mcp(agyspeak/narrate)", "mcp(agyspeak/stop_speaking)", "mcp(agyspeak/list_audio)", "mcp(agyspeak/replay_audio)", "mcp(agyspeak/unload_speech)"] } }
```

Note that `agy mcp add` is global, so the tool is visible to every agy session.
