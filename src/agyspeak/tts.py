"""Local text-to-speech backends: Kokoro, Qwen3-TTS, and macOS `say`."""

from __future__ import annotations

import gc
import logging
import os
import queue
import subprocess
import threading
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

SPEECH_DIR = Path.home() / ".cache" / "agyspeak" / "speech"
KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_RATE = 24_000
EDGE_SILENCE_THRESHOLD = 0.001
EDGE_SILENCE_KEEP_SECONDS = 0.04
STREAM_START_BUFFER_SECONDS = 5.0
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


class SpeechCancelled(RuntimeError):
    pass


class NoAudioError(RuntimeError):
    pass


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
            model = KModel(
                repo_id=KOKORO_REPO,
                config=str(snap / "config.json"),
                model=str(snap / "kokoro-v1_0.pth"),
            ).eval()
            _pipelines[lang_code] = KPipeline(lang_code=lang_code, model=model, repo_id=KOKORO_REPO)
        return _pipelines[lang_code]


def warm_up(lang_code: str = "a") -> None:
    """Load the model in the background so the first call doesn't stall."""
    threading.Thread(target=_pipeline, args=(lang_code,), daemon=True).start()


def warm_voice(voice: str = DEFAULT_KOKORO_VOICE) -> None:
    """Validate a Kokoro voice and load its language pipeline in the background."""
    _voice(voice)
    warm_up(voice[0] if voice[:1] in KOKORO_LANGS else "a")


def kokoro_voices() -> list[str]:
    """Return locally available Kokoro voice ids."""
    return sorted(path.stem for path in (_snapshot(KOKORO_REPO) / "voices").glob("*.pt"))


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
        raise NoAudioError("kokoro produced no audio")
    return np.concatenate(chunks)


def save(audio: np.ndarray, path: Path | None = None) -> Path:
    if path is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        path = SPEECH_DIR / f"tts_{stamp}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio, KOKORO_RATE, subtype="PCM_16")
    return path


def kokoro_synth(text: str, voice: str = DEFAULT_KOKORO_VOICE, speed: float = 1.0) -> Path:
    """Synthesize text to a WAV under SPEECH_DIR and return its path."""
    return save(kokoro_render(text, voice, speed))


def line_engine(line: dict) -> str:
    """Return the engine selected by a script line."""
    requested = line.get("engine")
    if requested and requested != "auto":
        return str(requested)
    voice = line.get("voice") or DEFAULT_KOKORO_VOICE
    return "qwen" if voice in QWEN_SPEAKERS else "kokoro"


def _render_line(line: dict) -> np.ndarray:
    """Render one script line; everything is normalised to KOKORO_RATE."""
    def trim_edge_silence(audio: np.ndarray) -> np.ndarray:
        """Trim backend padding while retaining a short cushion."""
        active = np.flatnonzero(np.abs(audio) >= EDGE_SILENCE_THRESHOLD)
        if not len(active):
            return audio
        keep = int(KOKORO_RATE * EDGE_SILENCE_KEEP_SECONDS)
        start = max(0, int(active[0]) - keep)
        end = min(len(audio), int(active[-1]) + keep + 1)
        return audio[start:end]

    voice = line.get("voice") or DEFAULT_KOKORO_VOICE
    engine = line_engine(line)
    if engine == "qwen":
        audio, rate = qwen_render(
            line["text"],
            speaker=voice if voice in QWEN_SPEAKERS else DEFAULT_QWEN_SPEAKER,
            instruct=line.get("instruct"),
            language=line.get("language") or "auto",
        )
        audio = resample(audio, rate, KOKORO_RATE)
        speed = float(line.get("speed") or 1.0)
        audio = audio if speed == 1.0 else resample(
            audio, int(KOKORO_RATE * speed), KOKORO_RATE
        )
        return trim_edge_silence(audio)
    return trim_edge_silence(
        kokoro_render(line["text"], voice, float(line.get("speed") or 1.0))
    )


def _render_or_warn(line: dict) -> np.ndarray | None:
    try:
        return _render_line(line)
    except NoAudioError as exc:
        text = str(line.get("text") or "")
        logging.getLogger(__name__).warning(
            "Skipping unrenderable speech segment %r: %s", text[:80], exc
        )
        return None


def pause_before(line: dict, default: float) -> float:
    """Return a non-negative pause before a script line."""
    return max(0.0, float(line.get("pause_before", default)))


def kokoro_narrate(
    lines: list[dict],
    pause: float = 0.4,
    output_path: Path | None = None,
    stop_event: threading.Event | None = None,
) -> Path:
    """Render several {text, voice, speed} segments into one WAV with pauses between."""
    if not lines:
        raise RuntimeError("no lines to narrate")
    parts: list[np.ndarray] = []
    for index, line in enumerate(lines):
        if stop_event and stop_event.is_set():
            raise SpeechCancelled("speech cancelled")
        audio = _render_or_warn(line)
        if audio is None:
            continue
        if parts:
            parts.append(np.zeros(int(KOKORO_RATE * pause_before(line, pause)), dtype=np.float32))
        parts.append(audio)
    if stop_event and stop_event.is_set():
        raise SpeechCancelled("speech cancelled")
    if not parts:
        raise NoAudioError("speech produced no audio")
    return save(np.concatenate(parts), output_path)


def kokoro_narrate_streaming(
    lines: list[dict],
    pause: float = 0.4,
    output_path: Path | None = None,
    stop_event: threading.Event | None = None,
) -> Path:
    """Like kokoro_narrate, but start playing line 1 while the rest render.

    Playback starts after the first line is synthesized (a few seconds) instead
    of after the whole script. Each segment is played by its own `afplay`
    process so rendering in this process can't starve the audio output. The
    joined clip is still saved and returned.
    """
    if not lines:
        raise RuntimeError("no lines to narrate")
    ready: queue.Queue[tuple[np.ndarray, Path] | Exception | None] = queue.Queue()
    SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    if output_path is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        output_path = SPEECH_DIR / f"tts_{stamp}.wav"
    else:
        stamp = output_path.stem

    def render_all() -> None:
        try:
            _limit_render_threads()
            for i, line in enumerate(lines):
                if stop_event and stop_event.is_set():
                    raise SpeechCancelled("speech cancelled")
                audio = _render_or_warn(line)
                if audio is None:
                    continue
                if i < len(lines) - 1:
                    seconds = pause_before(lines[i + 1], pause)
                    gap = np.zeros(int(KOKORO_RATE * seconds), dtype=np.float32)
                    audio = np.concatenate([audio, gap])
                part = SPEECH_DIR / f"seg_{stamp}_{i:03d}.wav"
                sf.write(part, audio, KOKORO_RATE, subtype="PCM_16")
                ready.put((audio, part))
        except Exception as exc:  # surface to the player loop
            ready.put(exc)
        finally:
            ready.put(None)

    renderer = threading.Thread(target=render_all, daemon=True)
    renderer.start()
    parts: list[np.ndarray] = []
    buffered: list[tuple[np.ndarray, Path]] = []
    buffered_seconds = 0.0
    finished = False
    try:
        # A heading can be much shorter than the segment rendered behind it.
        # Hold a few seconds of ready audio before starting, then let rendering
        # continue concurrently with playback.
        while buffered_seconds < STREAM_START_BUFFER_SECONDS:
            item = ready.get()
            if item is None:
                finished = True
                break
            if isinstance(item, Exception):
                raise item
            buffered.append(item)
            buffered_seconds += len(item[0]) / KOKORO_RATE

        while buffered or not finished:
            if buffered:
                item = buffered.pop(0)
            else:
                queued = ready.get()
                if queued is None:
                    finished = True
                    continue
                if isinstance(queued, Exception):
                    raise queued
                item = queued
            if stop_event and stop_event.is_set():
                raise SpeechCancelled("speech cancelled")
            audio, part = item
            parts.append(audio)
            play(part, stop_event=stop_event)
    finally:
        renderer.join()
        for part in SPEECH_DIR.glob(f"seg_{stamp}_*.wav"):
            part.unlink(missing_ok=True)
    if not parts:
        raise NoAudioError("speech produced no audio")
    return save(np.concatenate(parts), output_path)


def _limit_render_threads() -> None:
    """Leave a core free for audio playback and the rest of the machine."""
    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 2) - 2))


_qwen_models: dict[str, object] = {}


def _register_qwen_transformers_config() -> None:
    """Teach AutoTokenizer the checkpoint's actual model type."""
    from transformers import AutoConfig, PreTrainedConfig

    class Qwen3TTSConfig(PreTrainedConfig):
        model_type = "qwen3_tts"

    try:
        AutoConfig.register(Qwen3TTSConfig.model_type, Qwen3TTSConfig)
    except ValueError as exc:
        if "already used" not in str(exc):
            raise


def _qwen(repo: str = QWEN_REPO):
    with _lock:
        if repo not in _qwen_models:
            _register_qwen_transformers_config()
            from mlx_audio.tts.utils import load_model  # slow import, keep it lazy

            _qwen_models[repo] = load_model(str(_snapshot(repo)))
        return _qwen_models[repo]


def load_model(engine: str, voice: str = DEFAULT_KOKORO_VOICE) -> None:
    """Load one speech engine synchronously inside the harness."""
    if engine == "kokoro":
        _voice(voice)
        _pipeline(voice[0] if voice[:1] in KOKORO_LANGS else "a")
        return
    if engine == "qwen":
        _qwen()
        return
    raise ValueError(f"unknown speech engine {engine!r}")


def loaded_models() -> dict[str, list[str]]:
    """Describe speech models currently held in memory without waiting for a load."""
    acquired = _lock.acquire(blocking=False)
    try:
        return {
            "kokoro": sorted(_pipelines),
            "qwen": sorted(_qwen_models),
        }
    finally:
        if acquired:
            _lock.release()


def unload_models(engine: str = "all") -> None:
    """Release cached speech models from this process."""
    if engine not in {"all", "kokoro", "qwen"}:
        raise ValueError(f"unknown speech engine {engine!r}")
    with _lock:
        if engine in {"all", "kokoro"}:
            _pipelines.clear()
        if engine in {"all", "qwen"}:
            _qwen_models.clear()
    gc.collect()


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
        raise NoAudioError("qwen produced no audio")
    return np.concatenate(chunks), rate


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return audio
    n = int(round(len(audio) * dst / src))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def play(path: Path, stop_event: threading.Event | None = None) -> None:
    if stop_event and stop_event.is_set():
        raise SpeechCancelled("speech cancelled")
    proc = subprocess.Popen(["afplay", str(path)])
    while proc.poll() is None:
        if stop_event and stop_event.wait(0.1):
            proc.terminate()
            proc.wait()
            raise SpeechCancelled("speech cancelled")
        if stop_event is None:
            proc.wait()
    if proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, proc.args)


def say(text: str, voice: str = DEFAULT_SAY_VOICE, rate: int | None = None) -> None:
    argv = ["say", "-v", voice]
    if rate:
        argv += ["-r", str(rate)]
    argv.append(text)
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"say exited {result.returncode}")
