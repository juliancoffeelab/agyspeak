# /// script
# requires-python = ">=3.13"
# dependencies = ["python-dotenv"]
# ///
"""Test an explicitly selected audio model on the two saved Swedish takes.

uv run scripts/openrouter_audio_probe.py
Reads OPENROUTER_API_KEY privately; stores final answers, never credentials.
Defaults to the latest Swedish A/B takes from recorder_gui.py --swedish.
Use --audio clip.wav --prompt 'Your question' to test another recording.
The default route is free; explicitly selecting other models incurs API charges.
"""

import argparse
import base64
from datetime import datetime
import json
import os
from pathlib import Path
from time import perf_counter
import urllib.error
import urllib.request

from dotenv import load_dotenv


MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
BASE = "https://openrouter.ai/api/v1"
DEFAULT_PROMPT = (
    "Listen to this Swedish recording. Give word-level pronunciation feedback only "
    "where supported by the audio. For each error, name the word, approximate "
    "timestamp, sound heard, expected sound, and a short practice instruction. "
    "If the audio does not support a judgment, say uncertain. Respond in English."
)


def debug_shape(value, field=""):
    """Keep upstream request structure without printing text, media, or secrets."""
    if isinstance(value, dict):
        return {k: debug_shape(v, k) for k, v in value.items()
                if k.lower() not in {"authorization", "api_key", "reasoning", "reasoning_details"}}
    if isinstance(value, list):
        return [debug_shape(v, field) for v in value]
    if isinstance(value, str):
        if field in {"type", "role", "format", "model"}:
            return value
        if value.startswith("{"):
            try:
                return debug_shape(json.loads(value))
            except ValueError:
                pass
        return {"string_length": len(value)}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flex", action="store_true", help="Use only the Gemini Flash Flex endpoint")
    parser.add_argument("--model", choices=(MODEL, "qwen/qwen3.8-omni-flash", "xiaomi/mimo-v2.6-flash", "mistralai/voxtral-small-24b-2507", "google/gemini-3.8-flash", "google/gemini-3.5-flash-lite"), default=MODEL)
    parser.add_argument("--check-audio", action="store_true", help="Check that audio reaches the model without supplying reference text")
    parser.add_argument("--audio", type=Path, help="Test one specific WAV instead of the two saved takes")
    parser.add_argument("--wire-format", choices=("input_audio", "audio_url"), default="input_audio")
    parser.add_argument("--prompt", help="Override the probe question")
    parser.add_argument("--debug-upstream", action="store_true", help="Inspect a redacted structural summary of the provider request")
    args = parser.parse_args()
    model = args.model
    if args.flex and not model.startswith("google/gemini-"):
        parser.error("--flex requires Gemini Flash")
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise ValueError("OPENROUTER_API_KEY missing")
    # Check live endpoint prices before using the key for an inference request.
    with urllib.request.urlopen(f"{BASE}/models/{model}/endpoints", timeout=30) as response:
        endpoints = json.load(response)["data"]["endpoints"]
    free = [e for e in endpoints if e["provider_name"] == "Nvidia"
            and all(float(e["pricing"][field]) == 0 for field in ("prompt", "completion"))]
    if model == MODEL and not free:
        raise ValueError("No verified zero-price Nvidia endpoint")
    provider = ({"only": ["Nvidia"], "allow_fallbacks": False} if model == MODEL else
                {"max_price": {"prompt": 1, "completion": 2}})
    if model.startswith("google/gemini-"):
        provider = {"only": ["google-ai-studio"], "ignore": ["google-ai-studio/flex", "google-ai-studio/priority"],
                    "allow_fallbacks": False, "max_price": {"prompt": 1, "completion": 5}}
        if args.flex:
            provider = {"only": ["google-ai-studio/flex"], "allow_fallbacks": False,
                        "max_price": {"prompt": 0.375, "completion": 1.875}}

    directory = Path.home() / "Music" / "AGSpeak Recordings"
    directory.mkdir(parents=True, exist_ok=True)
    prompt = DEFAULT_PROMPT
    if args.check_audio:
        prompt = ("What language is spoken in the recording? Give the first five spoken words. "
                  "If you did not receive usable audio, say so. Do not guess from this question.")
    if args.prompt:
        prompt = args.prompt
    mode = "audio-check" if args.check_audio else "swedish"
    if args.flex:
        mode += "-flex"
    output = directory / f"{model.split('/')[-1]}-{mode}-{args.wire_format}-{datetime.now():%Y%m%d-%H%M%S-%f}.json"
    report = dict(model=model, provider_request=provider, wire_format=args.wire_format, prompt=prompt, results=[])
    takes = [("custom", args.audio)] if args.audio else [
        (label, sorted(directory.glob(f"eval-swedish-{label}-*.wav"))[-1])
        for label in ("incorrect", "correct")]
    for label, audio in takes:
        encoded = base64.b64encode(audio.read_bytes()).decode("ascii")
        audio_part = ({"type": "input_audio", "input_audio": {"data": encoded, "format": "wav"}}
                      if args.wire_format == "input_audio" else
                      {"type": "audio_url", "audio_url": {"url": f"data:audio/wav;base64,{encoded}"}})
        request_body = {
            "model": model,
            "provider": provider,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                audio_part,
            ]}],
            "max_tokens": 4096,
            "reasoning": {"exclude": True},
        }
        if model.startswith("google/gemini-"):
            request_body["reasoning"]["effort"] = "low"
        if args.debug_upstream:
            request_body.update(stream=True, debug={"echo_upstream_body": True})
        request = urllib.request.Request(f"{BASE}/chat/completions",
            data=json.dumps(request_body).encode(), method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        result = dict(label=label, audio=str(audio), wire_format=args.wire_format)
        started = perf_counter()
        print(f"Sending {label} take to {model}…", flush=True)
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                if not args.debug_upstream:
                    data = json.load(response)
                else:
                    data = {"choices": [{"message": {"content": ""}, "finish_reason": None}]}
                    for line in response:
                        line = line.decode("utf-8").strip()
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        chunk = json.loads(payload)
                        if chunk.get("debug"):
                            result["upstream_debug"] = debug_shape(chunk["debug"])
                        for field in ("usage", "provider", "model", "error"):
                            if chunk.get(field) is not None:
                                data[field] = chunk[field]
                        for choice in chunk.get("choices", []):
                            text = choice.get("delta", {}).get("content")
                            if text:
                                data["choices"][0]["message"]["content"] += text
                            if choice.get("finish_reason"):
                                data["choices"][0]["finish_reason"] = choice["finish_reason"]
            if data.get("error"):
                result["error"] = str(data["error"].get("message", "Provider error")).replace(key, "[redacted]")[:500]
            else:
                choice = data["choices"][0]
                result.update(response=choice["message"].get("content"),
                              finish_reason=choice.get("finish_reason"), usage=data.get("usage"),
                              provider=data.get("provider"), model=data.get("model"))
        except urllib.error.HTTPError as exc:
            result["http_status"] = exc.code
            try:
                error = json.loads(exc.read()).get("error", {})
                result["error"] = str(error.get("message", "Provider request failed")).replace(key, "[redacted]")[:500]
                metadata = error.get("metadata") or {}
                if metadata.get("raw"):
                    result["provider_error"] = str(metadata["raw"]).replace(key, "[redacted]")[:1000]
            except Exception:
                result["error"] = "Provider request failed"
        except Exception as exc:
            result["error"] = type(exc).__name__
        result["seconds"] = perf_counter() - started
        report["results"].append(result)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
    print(f"Saved: {output}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Probe stopped ({type(exc).__name__}); request details suppressed.")
        raise SystemExit(1)
