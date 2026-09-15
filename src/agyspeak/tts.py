"""Local text-to-speech backends: Kokoro (neural, default) and macOS `say`."""

from __future__ import annotations

import logging
import os
import queue
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

# Qwen3-TTS via mlx-audio (Apple Silicon). 0.6B 8-bit fits alongside Kokoro in 8 GB RAM.
QWEN_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
QWEN_SPEAKERS = ("Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee")
DEFAULT_QWEN_SPEAKER = "Ryan"

# Kokoro voice prefixes: a=American, b=British English; then f/m for gender.
KOKORO_LANGS = {"a": "American English", "b": "British English"}

_pipelines: dict[str, object] = {}
_lock = threading.Lock()


def _snapshot(repo: str) -> Path:
    """Local directory for a Hub repo: cached copy if complete, else download."""
    from huggingface_hub import snapshot_download

    try:
        return Path(snapshot_download(repo, local_files_only=True))
    except Exception:
        return Path(snapshot_download(repo))


def _pipeline(lang_code: str):
    with _lock:
        if lang_code not in _pipelines:
            logging.getLogger("httpx").setLevel(logging.WARNING)
            from kokoro import KModel, KPipeline  # slow import, keep it lazy

            snap = _snapshot(KOKORO_REPO)
            model = KModel(config=str(snap / "config.json"), model=str(snap / "kokoro-v1_0.pth"))
            _pipelines[lang_code] = KPipeline(lang_code=lang_code, model=model, repo_id=KOKORO_REPO)
        return _pipelines[lang_code]


def warm_up(lang_code: str = "a") -> None:
    """Load the model in the background so the first call doesn't stall."""
    threading.Thread(target=_pipeline, args=(lang_code,), daemon=True).start()


def _voice(voice: str) -> str:
    """Resolve a voice id, or a blend like "af_heart+bf_emma", to local voice files."""
    voices_dir = _snapshot(KOKORO_REPO) / "voices"
    paths = []
    for name in (v.strip() for v in voice.split("+")):
        path = voices_dir / f"{name}.pt"
        if not path.exists():
            raise ValueError(f"unknown voice {name!r}")
        paths.append(str(path))
    return ",".join(paths)


def kokoro_render(text: str, voice: str = DEFAULT_KOKORO_VOICE, speed: float = 1.0) -> np.ndarray:
    """Synthesize text and return float32 samples at KOKORO_RATE."""
    lang_code = voice[0] if voice[:1] in KOKORO_LANGS else "a"
    pipe = _pipeline(lang_code)
    chunks = [np.asarray(audio) for _, _, audio in pipe(text, voice=_voice(voice), speed=speed)]
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


def _render_line(line: dict) -> np.ndarray:
    """Render one script line; everything is normalised to KOKORO_RATE."""
    voice = line.get("voice") or DEFAULT_KOKORO_VOICE
    engine = line.get("engine") or ("qwen" if voice in QWEN_SPEAKERS else "kokoro")
    if engine == "qwen":
        audio, rate = qwen_render(
            line["text"],
            speaker=voice if voice in QWEN_SPEAKERS else DEFAULT_QWEN_SPEAKER,
            instruct=line.get("instruct"),
            language=line.get("language") or "auto",
        )
        audio = resample(audio, rate, KOKORO_RATE)
        speed = float(line.get("speed") or 1.0)
        return audio if speed == 1.0 else resample(audio, int(KOKORO_RATE * speed), KOKORO_RATE)
    return kokoro_render(line["text"], voice, float(line.get("speed") or 1.0))


def kokoro_narrate(lines: list[dict], pause: float = 0.4) -> Path:
    """Render several {text, voice, speed} segments into one WAV with pauses between."""
    if not lines:
        raise RuntimeError("no lines to narrate")
    gap = np.zeros(int(KOKORO_RATE * pause), dtype=np.float32)
    parts: list[np.ndarray] = []
    for line in lines:
        if parts:
            parts.append(gap)
        parts.append(_render_line(line))
    return save(np.concatenate(parts))


def kokoro_narrate_streaming(lines: list[dict], pause: float = 0.4) -> Path:
    """Like kokoro_narrate, but start playing line 1 while the rest render.

    Playback starts after the first line is synthesized (a few seconds) instead
    of after the whole script. Each segment is played by its own `afplay`
    process so rendering in this process can't starve the audio output. The
    joined clip is still saved and returned.
    """
    if not lines:
        raise RuntimeError("no lines to narrate")
    gap = np.zeros(int(KOKORO_RATE * pause), dtype=np.float32)
    ready: queue.Queue[tuple[np.ndarray, Path] | Exception | None] = queue.Queue()
    SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    def render_all() -> None:
        try:
            _limit_render_threads()
            for i, line in enumerate(lines):
                audio = _render_line(line)
                if i < len(lines) - 1:
                    audio = np.concatenate([audio, gap])
                part = SPEECH_DIR / f"seg_{stamp}_{i:03d}.wav"
                sf.write(part, audio, KOKORO_RATE, subtype="PCM_16")
                ready.put((audio, part))
        except Exception as exc:  # surface to the player loop
            ready.put(exc)
        finally:
            ready.put(None)

    threading.Thread(target=render_all, daemon=True).start()
    parts: list[np.ndarray] = []
    current: subprocess.Popen | None = None
    while (item := ready.get()) is not None:
        if current is not None:
            current.wait()  # previous segment done
        if isinstance(item, Exception):
            raise item
        audio, part = item
        current = subprocess.Popen(["afplay", str(part)])
        parts.append(audio)
    if current is not None:
        current.wait()
    for i in range(len(parts)):
        (SPEECH_DIR / f"seg_{stamp}_{i:03d}.wav").unlink(missing_ok=True)
    return save(np.concatenate(parts))


def _limit_render_threads() -> None:
    """Leave a core free for audio playback and the rest of the machine."""
    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 2) - 2))


_qwen_models: dict[str, object] = {}


def _qwen(repo: str = QWEN_REPO):
    with _lock:
        if repo not in _qwen_models:
            from mlx_audio.tts.utils import load_model  # slow import, keep it lazy

            _qwen_models[repo] = load_model(str(_snapshot(repo)))
        return _qwen_models[repo]


def qwen_render(
    text: str,
    speaker: str = DEFAULT_QWEN_SPEAKER,
    instruct: str | None = None,
    language: str = "auto",
    repo: str = QWEN_REPO,
) -> tuple[np.ndarray, int]:
    """Synthesize with Qwen3-TTS; returns (float32 samples, sample rate).

    `instruct` is a free-text style direction ("whispering, conspiratorial",
    "barely holding back laughter"), which is the thing Kokoro cannot do.
    """
    model = _qwen(repo)
    rate = KOKORO_RATE
    chunks: list[np.ndarray] = []
    for result in model.generate_custom_voice(
        text, speaker=speaker, language=language, instruct=instruct or None
    ):
        chunks.append(np.asarray(result.audio, dtype=np.float32))
        rate = int(getattr(result, "sample_rate", rate) or rate)
    if not chunks:
        raise RuntimeError("qwen produced no audio")
    return np.concatenate(chunks), rate


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return audio
    n = int(round(len(audio) * dst / src))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


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
