# /// script
# requires-python = ">=3.13"
# dependencies = ["google-genai", "python-dotenv"]
# ///
"""Blind synthetic-voice check: uv run scripts/gemini_voice_benchmark.py.

Requires macOS say. Sends eight synthetic clips to Gemini; saves results in /tmp.
Voice labels and filenames are never included in model requests.
"""

import json
import hashlib
import os
from pathlib import Path
import random
import subprocess
import tempfile
from time import perf_counter

from dotenv import load_dotenv
from google import genai
from google.genai import types


VOICES = [
    ("com.apple.voice.compact.en-US.Ava", "female", "American"),
    ("com.apple.speech.synthesis.voice.Fred", "male", "American"),
    ("com.apple.voice.compact.en-GB.Daniel", "male", "British"),
    ("com.apple.voice.premium.en-GB.Malcolm", "male", "British"),
]
SENTENCES = [
    "I parked the car near the garden, then asked for a glass of water.",
    "On Saturday afternoon, my brother bought a better bottle of tomato sauce.",
]
PROMPTS = {
    "voice": "Does this voice sound male or female? Answer with one word: male, female, or unclear.",
    "accent": "What English dialect or accent do you hear in this recording? Answer briefly.",
}


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    token = os.environ.get("GEMINI_TOKEN")
    if not token:
        raise ValueError("GEMINI_TOKEN is missing")
    output = Path(tempfile.mkdtemp(prefix="agyspeak-voice-benchmark-"))
    cases = [(voice, sex, accent, i, sentence)
             for voice, sex, accent in VOICES for i, sentence in enumerate(SENTENCES)]
    random.Random(42).shuffle(cases)
    results = []
    clips = []
    hashes = set()
    for number, (voice, sex, accent, sentence_id, sentence) in enumerate(cases, 1):
        path = output / f"clip-{number:02d}.wav"
        subprocess.run(["say", "-v", voice, "-r", "170", "-o", str(path),
                        "--file-format=WAVE", "--data-format=LEI16@16000", sentence],
                       check=True, capture_output=True, timeout=60)
        audio = path.read_bytes()
        digest = hashlib.sha256(audio).hexdigest()
        if digest in hashes:
            print(f"Duplicate audio for {voice}; stopping before API calls. Clips: {output}", flush=True)
            raise ValueError("Voices did not produce distinct audio")
        hashes.add(digest)
        clips.append(path)
    print("Verified eight distinct audio files.", flush=True)
    with genai.Client(api_key=token, http_options=types.HttpOptions(
        timeout=60_000, retry_options=types.HttpRetryOptions(attempts=1)
    )) as client:
        for number, (voice, sex, accent, sentence_id, sentence) in enumerate(cases, 1):
            path = clips[number - 1]
            answer = {}
            timings = {}
            for task, prompt in PROMPTS.items():
                started = perf_counter()
                first = None
                text = ""
                for chunk in client.models.generate_content_stream(
                    model="gemini-3.5-flash-lite",
                    contents=[types.Part.from_bytes(data=path.read_bytes(), mime_type="audio/wav"), prompt],
                    config=types.GenerateContentConfig(
                        max_output_tokens=128,
                        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
                    ),
                ):
                    if chunk.text:
                        if first is None:
                            first = perf_counter() - started
                        text += chunk.text
                answer[task] = text.strip()
                timings[task] = dict(first_text_seconds=first, total_seconds=perf_counter() - started)
                print(f"{number}/8 {voice} [{task}]: {answer[task]} "
                      f"({timings[task]['total_seconds']:.2f}s)", flush=True)
            result = dict(voice_name=voice, expected_voice=sex, expected_accent=accent,
                          sentence_id=sentence_id, sentence=sentence, answer=answer,
                          timings=timings, audio=str(path))
            results.append(result)
            (output / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\nVoice: {sum(r['expected_voice'] == r['answer']['voice'].lower().strip('.') for r in results)}/8")
    print(f"Results and audio: {output}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Avoid exception bodies that could include request credentials.
        print(f"Benchmark failed ({type(exc).__name__}); request details suppressed.")
        raise SystemExit(1)
