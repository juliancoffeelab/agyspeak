# agyspeak

Terminal chat with Gemini that lets you talk instead of type. It records your
microphone and sends the recording to Gemini through Google's Antigravity
runtime, so it runs on your Antigravity subscription with no API key.

<img width="722" height="616" alt="зображення" src="https://github.com/user-attachments/assets/03ea03fa-f18f-4f6b-95cc-d0f2f2b37265" />


## Requirements

- macOS
- Python 3.13 and [uv](https://docs.astral.sh/uv/)
- The Antigravity ACP runtime, installed once with:

  ```sh
  uv run python -m agyspeak.acp_runtime
  ```

The first message opens your browser to sign in to Antigravity.

## Run

```sh
uv run agyspeak
```

Press Enter on an empty prompt to record, and Enter again to send. Press Tab
to have replies spoken aloud. `uv run agyspeak --help` lists the options and
`/help` inside the chat lists the commands.

## Android app

A separate phone app lives in [`reactnative/`](reactnative/README.md).

# More screenshots
<img width="721" height="578" alt="зображення" src="https://github.com/user-attachments/assets/39727adc-fd08-4ce5-886c-12235d701c45" />
<img width="720" height="749" alt="зображення" src="https://github.com/user-attachments/assets/b3135dc7-b33d-4b77-984d-05a763394536" />


# Notes
It's a funny experiment made with Fable and Sol. If something isn't right, tell
your chatbot to figure it out.
