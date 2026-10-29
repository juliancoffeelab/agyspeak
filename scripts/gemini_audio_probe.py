# /// script
# requires-python = ">=3.13"
# dependencies = ["google-genai", "python-dotenv", "sounddevice", "soundfile"]
# ///
"""Probe Gemini audio coaching: uv run scripts/gemini_audio_probe.py --record 10.

Alternatively pass a WAV/MP3/M4A file. Sends that audio to the Gemini API.
Loads GEMINI_TOKEN from the repository .env without displaying credentials.
"""

import argparse
import io
import mimetypes
import os
from pathlib import Path
import sys
from time import perf_counter

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types


PROMPT = """Listen to the actual vocal delivery in this recording.
Give brief voice coaching in under 120 words: one strength, one improvement,
and one concrete exercise. Support observations with a quoted phrase or an
approximate moment in the clip. Focus on audible pacing, pauses, stress,
intonation, and clarity. Do not infer personality or emotional state. Do not
invent precise measurements or pronunciation errors. If the recording does
not support a judgment, say so. If there is no speech, say so.
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("audio", nargs="?", type=Path)
    source.add_argument("--record", type=float, metavar="SECONDS")
    parser.add_argument("--model", default="gemini-3.5-flash-lite")
    parser.add_argument("--thinking", choices=["minimal", "low", "medium", "high"],
                        default="minimal")
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--max-output-tokens", type=int, default=512)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.max_output_tokens < 1:
        parser.error("--max-output-tokens must be positive")

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    token = os.environ.get("GEMINI_TOKEN")
    if not token:
        parser.error("GEMINI_TOKEN is missing")

    if args.record is not None:
        if not 0 < args.record <= 60:
            parser.error("--record must be between 0 and 60 seconds")
        import sounddevice as sd
        import soundfile as sf

        print(f"Recording {args.record:g}s now. Speak into your microphone.", flush=True)
        recording = sd.rec(int(args.record * 16000), samplerate=16000,
                           channels=1, dtype="int16")
        sd.wait()
        buffer = io.BytesIO()
        sf.write(buffer, recording, 16000, format="WAV", subtype="PCM_16")
        audio, mime = buffer.getvalue(), "audio/wav"
    else:
        if not args.audio.is_file():
            parser.error("Audio file does not exist")
        if args.audio.stat().st_size > 14_000_000:
            parser.error("Use a clip under 14 MB for inline audio")
        audio = args.audio.read_bytes()
        mime = {".wav": "audio/wav", ".mp3": "audio/mp3", ".m4a": "audio/mp4"}.get(
            args.audio.suffix.lower(), mimetypes.guess_type(args.audio)[0])
        if not mime or not mime.startswith("audio/"):
            parser.error("Expected a supported audio file")

    with genai.Client(api_key=token, http_options=types.HttpOptions(
        timeout=60_000, retry_options=types.HttpRetryOptions(attempts=1)
    )) as client:
        for run in range(1, args.runs + 1):
            print(f"\n{args.model}, run {run}/{args.runs}, {len(audio):,} audio bytes", flush=True)
            started = perf_counter()
            first_text = None
            usage = None
            finish = None
            try:
                for chunk in client.models.generate_content_stream(
                    model=args.model,
                    contents=[types.Part.from_bytes(data=audio, mime_type=mime), args.prompt],
                    config=types.GenerateContentConfig(
                        max_output_tokens=args.max_output_tokens,
                        thinking_config=types.ThinkingConfig(thinking_level=args.thinking),
                    ),
                ):
                    if chunk.text:
                        if first_text is None:
                            first_text = perf_counter() - started
                        print(chunk.text, end="", flush=True)
                    if chunk.usage_metadata:
                        usage = chunk.usage_metadata
                    for candidate in chunk.candidates or []:
                        if candidate.finish_reason:
                            finish = candidate.finish_reason
            except errors.APIError as exc:
                # Do not dump exception bodies, request headers, or credentials.
                print(f"\nAPI request failed: HTTP {exc.code} ({exc.status}).", file=sys.stderr)
                return 1
            elapsed = perf_counter() - started
            first = f"{first_text:.2f}s" if first_text is not None else "no text"
            print(f"\n\nFirst text: {first} | Total: {elapsed:.2f}s | Finish: {finish}")
            if usage:
                print(f"Tokens: input={usage.prompt_token_count}, output={usage.candidates_token_count}, "
                      f"thinking={usage.thoughts_token_count or 0}")
            if first_text is None:
                return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        # Keep unexpected SDK/network failures from exposing request details.
        print(f"Test failed ({type(exc).__name__}); no request details printed.", file=sys.stderr)
        sys.exit(1)
