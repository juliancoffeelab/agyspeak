"""Local text-to-speech backends: Kokoro (neural, default) and macOS `say`."""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SPEECH_DIR = Path.home() / ".cache" / "agyspeak" / "speech"
KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_RATE = 24_000
DEFAULT_KOKORO_VOICE = "af_heart"
DEFAULT_SAY_VOICE = "Samantha"

# Kokoro voice prefixes: a=American, b=British English; then f/m for gender.
KOKORO_LANGS = {"a": "American English", "b": "British English"}

_pipelines: dict[str, object] = {}
_lock = threading.Lock()


def _prefer_cache() -> None:
    """Skip Hub round-trips once the model is cached; downloads still work otherwise.

    Must run before huggingface_hub is imported: it reads HF_HUB_OFFLINE at import.
    """
    hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub")
    snapshots = hub / f"models--{KOKORO_REPO.replace('/', '--')}" / "snapshots"
    if any(snapshots.glob("*/kokoro-v1_0.pth")):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")


def _pipeline(lang_code: str):
    with _lock:
        if lang_code not in _pipelines:
            _prefer_cache()
            logging.getLogger("httpx").setLevel(logging.WARNING)
            from kokoro import KPipeline  # slow import, keep it lazy

            _pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id=KOKORO_REPO)
        return _pipelines[lang_code]


def warm_up(lang_code: str = "a") -> None:
    """Load the model in the background so the first call doesn't stall."""
    threading.Thread(target=_pipeline, args=(lang_code,), daemon=True).start()


def _voice(pipe, voice: str):
    """Resolve a voice id, or an even blend like "af_heart+bf_emma"."""
    names = [v.strip() for v in voice.split("+") if v.strip()]
    if len(names) <= 1:
        return voice
    import torch

    packs = [pipe.load_voice(n) for n in names]
    return torch.stack(packs).mean(dim=0)


def kokoro_render(text: str, voice: str = DEFAULT_KOKORO_VOICE, speed: float = 1.0) -> np.ndarray:
    """Synthesize text and return float32 samples at KOKORO_RATE."""
    lang_code = voice[0] if voice[:1] in KOKORO_LANGS else "a"
    pipe = _pipeline(lang_code)
    chunks = [np.asarray(audio) for _, _, audio in pipe(text, voice=_voice(pipe, voice), speed=speed)]
    if not chunks:
        raise RuntimeError("kokoro produced no audio")
    return np.concatenate(chunks)


def save(audio: np.ndarray) -> Path:
    SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    path = SPEECH_DIR / f"tts_{time.strftime('%Y%m%d-%H%M%S')}.wav"
    sf.write(path, audio, KOKORO_RATE, subtype="PCM_16")
    return path


def kokoro_synth(text: str, voice: str = DEFAULT_KOKORO_VOICE, speed: float = 1.0) -> Path:
    """Synthesize text to a WAV under SPEECH_DIR and return its path."""
    return save(kokoro_render(text, voice, speed))


def kokoro_narrate(lines: list[dict], pause: float = 0.4) -> Path:
    """Render several {text, voice, speed} segments into one WAV with pauses between."""
    gap = np.zeros(int(KOKORO_RATE * pause), dtype=np.float32)
    parts: list[np.ndarray] = []
    for line in lines:
        if parts:
            parts.append(gap)
        parts.append(
            kokoro_render(
                line["text"],
                line.get("voice") or DEFAULT_KOKORO_VOICE,
                float(line.get("speed") or 1.0),
            )
        )
    if not parts:
        raise RuntimeError("no lines to narrate")
    return save(np.concatenate(parts))


def play(path: Path) -> None:
    subprocess.run(["afplay", str(path)], check=True)


def say(text: str, voice: str = DEFAULT_SAY_VOICE, rate: int | None = None) -> None:
    argv = ["say", "-v", voice]
    if rate:
        argv += ["-r", str(rate)]
    argv.append(text)
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"say exited {result.returncode}")
