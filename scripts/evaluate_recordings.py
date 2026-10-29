# /// script
# requires-python = ">=3.13"
# dependencies = ["google-genai", "python-dotenv"]
# ///
"""Run blind listening probes on the latest GUI takes. Never displays the API key.

uv run scripts/evaluate_recordings.py
Results are JSON beside the recordings. Labels describe intended performances,
not independently verified acoustic ground truth. No filenames reach the model.
"""

import concurrent.futures
from datetime import datetime
import json
import os
from pathlib import Path
import threading
from time import perf_counter

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types


CASES = [
    ("th-normal", "th", "th"), ("th-d", "th", "d"), ("th-z", "th", "z"),
    ("garden-first", "stress", "first"), ("garden-second", "stress", "second"),
    ("emphasis-i", "emphasis", "I"), ("emphasis-car", "emphasis", "car"),
    ("rhythm-smooth", "pauses", "no deliberate internal pauses"),
    ("rhythm-pauses", "pauses", "after brother and bottle"),
    ("natural-1", "natural", None), ("natural-2", "natural", None),
    ("natural-3", "natural", None),
]
TASKS = {
    "th": "In the word brother, what consonant do you hear between the vowels? Observation must be one of: th, d, z, other, unclear. Use th for the voiced dental fricative /ð/.",
    "stress": "Which syllable of garden has greater stress? Observation must be one of: first, second, equal, unclear.",
    "emphasis": "Which single word receives the strongest contrastive emphasis? Observation must be that word, or none, or unclear.",
    "pauses": "Identify audible pauses within the spoken sentence, excluding silence before and after speaking. Observation should list the words immediately before each clear pause, or none, or unclear.",
    "natural": "Give at most one specific pronunciation correction, only if clearly supported by the recording. Observation should be the correction or none. Do not assume a target accent or criticize a pronunciation solely for being non-native.",
}
SCHEMA = {
    "type": "object",
    "properties": {key: {"type": "string"} for key in ("transcript", "observation", "evidence")},
    "required": ["transcript", "observation", "evidence"],
}


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    token = os.environ.get("GEMINI_TOKEN")
    if not token:
        raise ValueError("GEMINI_TOKEN missing")
    directory = Path.home() / "Music" / "AGSpeak Recordings"
    output = directory / f"evaluation-{datetime.now():%Y%m%d-%H%M%S}.json"
    selected = []
    for slug, task, intended in CASES:
        takes = sorted(directory.glob(f"eval-{slug}-*.wav"))
        if not takes:
            raise ValueError(f"Missing recording: {slug}")
        selected.append(dict(slug=slug, task=task, intended=intended,
                             path=str(takes[-1]), take_count=len(takes)))
    report = dict(note="Intended labels, not verified ground truth", selected=selected, results=[])
    output.write_text(json.dumps(report, indent=2))
    lock = threading.Lock()

    def run_model(model, thinking):
        # Sequential calls within each model; the two independent models run concurrently.
        jobs = [(case, 1) for case in selected]
        jobs += [(case, repeat) for case in selected if case["slug"] in {"th-normal", "garden-first"}
                 for repeat in (2, 3)]
        with genai.Client(api_key=token, http_options=types.HttpOptions(
            timeout=60_000, retry_options=types.HttpRetryOptions(attempts=1)
        )) as client:
            consecutive_errors = 0
            for case, repeat in jobs:
                prompt = ("Listen to the audio. Transcribe exactly what is spoken, preserving mistakes and false starts; "
                          "use [unclear] for unintelligible words. " + TASKS[case["task"]] +
                          " Give brief acoustic evidence for the observation; do not invent details. "
                          "If the target word is absent or unintelligible, answer unclear.")
                result = dict(slug=case["slug"], model=model, thinking=thinking, repeat=repeat)
                started = perf_counter()
                first = None
                text = ""
                try:
                    finish = None
                    for chunk in client.models.generate_content_stream(
                        model=model,
                        contents=[types.Part.from_bytes(data=Path(case["path"]).read_bytes(), mime_type="audio/wav"), prompt],
                        config=types.GenerateContentConfig(
                            max_output_tokens=1024, response_mime_type="application/json",
                            response_json_schema=SCHEMA,
                            thinking_config=types.ThinkingConfig(thinking_level=thinking),
                        ),
                    ):
                        if chunk.text:
                            if first is None:
                                first = perf_counter() - started
                            text += chunk.text
                        for candidate in chunk.candidates or []:
                            if candidate.finish_reason:
                                finish = str(candidate.finish_reason)
                    result.update(answer=json.loads(text), finish=finish)
                except errors.APIError as exc:
                    result["error"] = f"HTTP {exc.code}"
                except Exception as exc:
                    result["error"] = type(exc).__name__
                result.update(first_text_seconds=first, total_seconds=perf_counter() - started)
                with lock:
                    report["results"].append(result)
                    output.write_text(json.dumps(report, indent=2, ensure_ascii=False))
                    answer = result.get("answer", {}).get("observation", result.get("error"))
                    print(f"{len(report['results'])}/32 {model} {case['slug']} r{repeat}: {answer} "
                          f"({result['total_seconds']:.1f}s)", flush=True)
                consecutive_errors = consecutive_errors + 1 if "error" in result else 0
                if consecutive_errors >= 3:
                    print(f"Stopping {model} after three consecutive failures; remaining cases untested.", flush=True)
                    break

    print(f"Selected latest take for all 12 prompts. Results: {output}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run_model, "gemini-3.5-flash-lite", "minimal"),
                   pool.submit(run_model, "gemini-3.8-flash", "low")]
        for future in futures:
            future.result()
    print(f"Run finished; check results for errors or untested cases. Results: {output}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Evaluation stopped ({type(exc).__name__}); no request details printed.")
        raise SystemExit(1)
