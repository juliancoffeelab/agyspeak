# agyspeak

Terminal chat with Gemini that lets you talk instead of type. It records your
microphone to a WAV file and hands it to the Antigravity CLI (`agy`), so it runs
on your Antigravity subscription with no API key.

<img width="722" height="616" alt="зображення" src="https://github.com/user-attachments/assets/03ea03fa-f18f-4f6b-95cc-d0f2f2b37265" />


## Requirements

- macOS with the `agy` CLI installed and logged in
- Python 3.13 and [uv](https://docs.astral.sh/uv/)

## Run

```sh
uv run agyspeak                      # default model gemini-3.8-flash-medium
uv run agyspeak -m gemini-3.8-flash-low
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

Voice mode supports English/Swedish replies, using Kokoro.

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
| Ctrl-X             | stop speech at the prompt, keeping voice mode on           |
| `/help`, `/quit`   |                                                          |

Recordings are 16 kHz mono WAV under `~/.cache/agyspeak/recordings/`
(`latest.wav` points at the newest one). Sessions are registered in
`~/.cache/agyspeak/sessions.jsonl`; on exit the app prints how to resume the
current one.

Long WAV recordings are split locally into parts of at most three minutes,
without lossy compression or changing the original. AGSpeak sends them in order
within the same conversation, asks for an acknowledgment after each intermediate
part, then asks for the answer after the final part. The terminal shows progress
and each file being opened. If a part fails or is blocked, processing stops.
A bare `@/path/to/recording.wav` at the chat prompt uses the same audio handling.

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

`agy mcp add` is global and makes the tools visible to every
`agy` session.

# More screenshots
<img width="721" height="578" alt="зображення" src="https://github.com/user-attachments/assets/39727adc-fd08-4ce5-886c-12235d701c45" />
<img width="720" height="749" alt="зображення" src="https://github.com/user-attachments/assets/b3135dc7-b33d-4b77-984d-05a763394536" />


# Notes
It's a funny experiment made with Fable and Sol. If something isn't right, tell
your chatbot to figure it out.
