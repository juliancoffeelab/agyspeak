# Implementation Plan - `agyspeak` CLI (Antigravity-Native Voice Tool)

We verified that the Antigravity CLI (`agy`) **natively supports audio files** via `@/path/to/audio.wav` and runs them directly through your **Antigravity subscription** (Gemini 3.7/3.8 Flash) with zero API keys or external billing required.

Tested live on your actual recording:
```sh
agy --model gemini-3.7-flash-high -p "Listen to this audio... @uploaded_media.m4a"
```
Gemini heard the dental stops, the laugh, the TRAP/GOAT vowels, and provided full phonetic feedback.

---

## Architecture

```
[ Microphone (macOS) ]
         │ (Press Enter to start / Enter to stop, or Space to hold)
         ▼
[ agyspeak Audio Recorder (sounddevice / soundfile) ]
         │ Saves uncompressed 16kHz WAV to cache (~/.cache/agyspeak/recordings/clip_<timestamp>.wav)
         ▼
[ Antigravity Backend (agy CLI runner) ]
         │ Submits prompt with `@/path/to/latest.wav` via your Antigravity subscription
         ▼
[ Terminal Display (Rich formatted phonetic markdown) ]
         │ Optional: macOS TTS speech feedback
```

---

## Technical Details

### Authentication & Backend
* **No API Key Needed**: `agyspeak` uses your local Antigravity CLI (`agy`), which is already authenticated with your Antigravity subscription via macOS Keychain.
* **Default Model**: `gemini-3.7-flash-high` (with `--model` CLI flag support to select `gemini-3.8-flash-high` or others).

---

## Implementation Modules

### 1. Audio Capture Module (`src/agyspeak/audio.py`)
- Microphone recording using `sounddevice` + `soundfile`.
- Records at 16 kHz mono (optimal for Gemini audio encoder).
- Visual recording indicator in terminal (`[🔴 Recording... Press Enter to stop]`).
- Peak volume meter / audio level monitor so you know your mic is picking up sound.
- Saves to `~/.cache/agyspeak/recordings/clip_<timestamp>.wav` (and creates a symlink `latest.wav`).

### 2. Antigravity Bridge Module (`src/agyspeak/backend.py`)
- Executes `agy` commands passing the audio file via `@/path/to/recording.wav`.
- Manages conversation context:
  - Single-shot mode: runs an independent prompt.
  - Interactive session: keeps conversation context alive using `agy --continue` or session IDs.
- Configurable modes:
  - **Pronunciation Coach (Default)**: In-depth acoustic analysis (IPA transcriptions, dental vs. alveolar stops, vowel duration, stress).
  - **Accent Mimic / Drill**: Compare against a specific target (e.g. *British RP*, *General American*, *Scottish*, etc.).
  - **Voice Prompt / Assistant**: General voice-to-agent instructions.

### 3. Practice Drills & Library (`src/agyspeak/drills.py`)
- Built-in phonetics drills:
  - Minimal pairs (e.g., *ship* vs. *sheep*, *bat* vs. *bet*).
  - Problem consonant clusters (*thr*, *th*, *dental t/d*).
  - Tongue twisters with acoustic scoring.

### 4. CLI Interface (`src/agyspeak/main.py`)
CLI powered by `typer` and `rich`:
- `agyspeak record [--target "British RP"] [--mode pronunciation|prompt]`: One-shot record and review.
- `agyspeak practice [drill-name]`: Interactive drill session (prompts a phrase, records your attempt, scores your phonetics).
- `agyspeak mic-check`: Live terminal VU meter to test audio input levels.

---

## Verification Plan

### Automated / Tool Tests
- Run `uv run agyspeak mic-check --duration 2` to verify audio capture.
- Run test verifying `agy` invocation with an existing audio file fixture.

### Manual Verification
- Run `uv run agyspeak record` -> speak a phrase -> confirm real-time phonetic analysis returned via Antigravity.
