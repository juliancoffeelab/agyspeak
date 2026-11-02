# /// script
# requires-python = ">=3.13"
# dependencies = ["google-genai", "python-dotenv", "numpy", "sounddevice", "soundfile"]
# ///
"""Blind order-swapped A/B stress comparison: uv run scripts/compare_stress.py."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from time import perf_counter

from dotenv import load_dotenv
from google import genai
from google.genai import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from agyspeak.backend import AgyClient


PROMPT = (
    "Compare recording A and recording B. In which recording does the SECOND syllable "
    "of garden have stronger emphasis RELATIVE TO ITS FIRST syllable? "
    "Compare the actual recordings, not the usual pronunciation of the word. "
    "Choose A, B, equal, or unclear, and briefly explain the audible difference. "
    "Return only a JSON object with string fields choice and evidence."
)
SCHEMA = {"type": "object", "properties": {
    "choice": {"type": "string", "enum": ["A", "B", "equal", "unclear"]},
    "evidence": {"type": "string"}}, "required": ["choice", "evidence"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swedish", action="store_true")
    args = parser.parse_args()
    directory = Path.home() / "Music" / "AGSpeak Recordings"
    pattern, labels = ("swedish", ("incorrect", "correct")) if args.swedish else ("garden", ("first", "second"))
    paths = [sorted(directory.glob(f"eval-{pattern}-{label}-*.wav"))[-1] for label in labels]
    prompt = PROMPT
    schema = SCHEMA
    if args.swedish:
        prompt = (
            "Listen to both recordings. Transcribe the speech in each in its original language, "
            "preserving mistakes and marking unintelligible words [unclear]. "
            "Compare their Swedish pronunciation. Which recording sounds closer to standard spoken Swedish: "
            "A, B, equal, or unclear? Describe the concrete pronunciation differences you actually hear, "
            "supported by specific words. Judge pronunciation, not recording length or fluency alone. "
            "Do not invent errors, infer speaker identity, or assume one recording must be better. "
            "Return only a JSON object with string fields choice, evidence, transcript_a, transcript_b. "
            "Keep the evidence under 150 words."
        )
        schema = {"type": "object", "properties": {
            **SCHEMA["properties"], "transcript_a": {"type": "string"}, "transcript_b": {"type": "string"}},
            "required": ["choice", "evidence", "transcript_a", "transcript_b"]}
    output = directory / f"{pattern}-ab-{datetime.now():%Y%m%d-%H%M%S}.json"
    report = dict(sources=[str(path) for path in paths], prompt=prompt, results=[])
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    token = os.environ["GEMINI_TOKEN"]

    def run(route):
        results = []
        for order in ((0, 1), (1, 0)):
            a, b = [paths[i] for i in order]
            result = dict(route=route, order=list(order), intended_second="A" if order[0] == 1 else "B")
            started = perf_counter()
            try:
                if route == "Lite API":
                    with genai.Client(api_key=token, http_options=types.HttpOptions(
                        timeout=60_000, retry_options=types.HttpRetryOptions(attempts=1)
                    )) as client:
                        reply = client.models.generate_content(
                            model="gemini-3.5-flash-lite",
                            contents=["Recording A:", types.Part.from_bytes(data=a.read_bytes(), mime_type="audio/wav"),
                                      "Recording B:", types.Part.from_bytes(data=b.read_bytes(), mime_type="audio/wav"), prompt],
                            config=types.GenerateContentConfig(
                                max_output_tokens=2048, response_mime_type="application/json",
                                response_json_schema=schema,
                                thinking_config=types.ThinkingConfig(thinking_level="minimal")),
                        )
                        text = reply.text
                else:
                    # Fresh anonymous copies prevent filenames from revealing labels.
                    folder = Path(tempfile.mkdtemp(prefix="agyspeak-ab-"))
                    for name, source in (("A", a), ("B", b)):
                        shutil.copyfile(source, folder / f"{name}.wav")
                    cli_prompt = (prompt + f"\nRecording A: {folder / 'A.wav'}\nRecording B: {folder / 'B.wav'}\n"
                              "Use the native file-viewing tool (view_file or read_file) to open BOTH files "
                              "and listen to their returned native audio. Do not use shell commands or "
                              "external transcription tools. If audio is unavailable, answer unclear.")
                    with AgyClient(preamble=None, turn_timeout=120) as client:
                        turn = client.send(cli_prompt)
                    text = turn.response.strip()
                    result.update(status=turn.status, denied_actions=len(turn.denied_actions), log=str(turn.log_path))
                    if text.startswith("```"):
                        text = "\n".join(text.splitlines()[1:-1])
                result["raw_answer"] = text
                result["answer"] = json.loads(text)
            except Exception as exc:
                result["error"] = type(exc).__name__
            result["seconds"] = perf_counter() - started
            print(json.dumps(result, ensure_ascii=False), flush=True)
            results.append(result)
        return results

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, route) for route in ("Lite API", "Medium ACP")]
        for future in as_completed(futures):
            report["results"].extend(future.result())
            output.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"Saved: {output}", flush=True)


if __name__ == "__main__":
    main()
