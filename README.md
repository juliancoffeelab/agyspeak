# agyspeak

Terminal chat with Gemini that lets you talk instead of type. It records your
microphone to a WAV file and hands it to the Antigravity CLI (`agy`), so it runs
on your Antigravity subscription with no API key.

## Requirements

- macOS with the `agy` CLI installed and logged in
- Python 3.13 and [uv](https://docs.astral.sh/uv/)

## Run

```sh
uv run agyspeak                      # default model gemini-3.7-flash-high
uv run agyspeak -m gemini-3.7-flash-low
uv run agyspeak -c                   # resume the last conversation
uv run agyspeak -l                   # list saved sessions
uv run agyspeak --conversation 2bbead17   # resume one by id (prefix is fine)
uv run agyspeak --yolo               # let agy run tools without asking
```

Press Tab at the prompt to toggle full voice mode. While enabled, every
model reply is cleaned of Markdown and spoken asynchronously with Kokoro; Tab
again unloads the model. Use `/voice <name>` to
switch voices or `/voices` to list them. `--voice bm_fable` selects the startup
voice without enabling speech. The selected voice and on/off state are restored
after restarting agyspeak, including when resuming with `-c`.

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
| `/speech status`   | show loaded models and queued work                        |
| `/speech load …`   | load Kokoro or Qwen in the background                     |
| `/speech unload …` | unload one engine or all speech models                    |
| `/speech stop`     | cancel current and queued speech                          |
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
- The `google-antigravity` Python SDK talks to the Gemini API directly and needs
  `GEMINI_API_KEY`, so it does not use the subscription. That is why this shells
  out to `agy` instead.

## Letting Gemini talk back (optional)

`agyspeak-mcp` adds local speech tools to `agy`. It can speak with Kokoro, Qwen3-TTS,
or macOS `say`, narrate scripts, stop playback, and replay saved audio. The speech
models run locally and download their weights on first use. `espeak-ng` is needed
by Kokoro for words outside its dictionary:

```sh
brew install espeak-ng
```

```sh
agy mcp add agyspeak "$PWD/.venv/bin/agyspeak-mcp"
```

For headless `agy`, allow the tools in
`~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp(agyspeak/speak)",
      "mcp(agyspeak/narrate)",
      "mcp(agyspeak/stop_speaking)",
      "mcp(agyspeak/list_audio)",
      "mcp(agyspeak/replay_audio)",
      "mcp(agyspeak/unload_speech)"
    ]
  }
}
```

Kokoro/Qwen playback and replay use the running `agyspeak` process. macOS `say`
can run directly. `agy mcp add` is global and makes the tools visible to every
`agy` session.

# Notes
It's a funny experiment made with Fable and Sol. If something isn't right, tell
your chatbot to figure it out.
