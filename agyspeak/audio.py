"""Microphone capture to WAV files that `agy` can attach."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

SAMPLE_RATE = 16_000
CHANNELS = 1
RECORDINGS_DIR = Path.home() / ".cache" / "agyspeak" / "recordings"


@dataclass
class Recorder:
    """Records from the default input device until `stop()` is called."""

    device: int | str | None = None
    sample_rate: int = SAMPLE_RATE
    _chunks: list[np.ndarray] = field(default_factory=list, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _stream: sd.InputStream | None = field(default=None, repr=False)
    _started_at: float = 0.0
    peak: float = 0.0
    rms: float = 0.0

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        block = indata[:, 0].copy()
        with self._lock:
            self._chunks.append(block)
            self.peak = float(np.max(np.abs(block))) if len(block) else 0.0
            self.rms = float(np.sqrt(np.mean(block**2))) if len(block) else 0.0

    def start(self) -> None:
        self._chunks.clear()
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=CHANNELS,
            dtype="float32",
            device=self.device,
            blocksize=int(self.sample_rate * 0.05),
            callback=self._callback,
        )
        self._stream.start()
        self._started_at = time.monotonic()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self._started_at if self._started_at else 0.0

    def stop(self) -> np.ndarray:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        with self._lock:
            if not self._chunks:
                return np.zeros(0, dtype="float32")
            return np.concatenate(self._chunks)

    def save(self, audio: np.ndarray, directory: Path = RECORDINGS_DIR) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = directory / f"clip_{stamp}.wav"
        sf.write(path, audio, self.sample_rate, subtype="PCM_16")
        latest = directory / "latest.wav"
        if latest.is_symlink() or latest.exists():
            latest.unlink()
        latest.symlink_to(path.name)
        return path


def list_input_devices() -> list[tuple[int, str]]:
    devices = sd.query_devices()
    return [(i, d["name"]) for i, d in enumerate(devices) if d["max_input_channels"] > 0]


def level_bar(rms: float, width: int = 30) -> str:
    """Render an ASCII VU bar from an RMS level in [0, 1]."""
    # Roughly perceptual: -50 dBFS .. 0 dBFS mapped onto the bar.
    db = 20 * np.log10(max(rms, 1e-6))
    frac = min(max((db + 50) / 50, 0.0), 1.0)
    filled = int(frac * width)
    return "█" * filled + "░" * (width - filled)
