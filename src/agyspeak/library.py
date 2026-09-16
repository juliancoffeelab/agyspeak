"""Index and resolve agyspeak recordings and generated speech."""

from __future__ import annotations

import json
import wave
from datetime import datetime
from pathlib import Path

from agyspeak import audio, tts


def _duration(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as wav:
            return round(wav.getnframes() / wav.getframerate(), 2)
    except (OSError, EOFError, wave.Error, ZeroDivisionError):
        return None


def list_audio(kind: str = "all", limit: int = 10) -> list[dict]:
    if kind not in {"all", "recording", "speech"}:
        raise ValueError("kind must be all, recording, or speech")
    entries: list[dict] = []
    if kind in {"all", "recording"}:
        for path in audio.RECORDINGS_DIR.glob("clip_*.wav"):
            entries.append(
                {
                    "kind": "recording",
                    "id": path.stem.removeprefix("clip_"),
                    "created_at": datetime.fromtimestamp(path.stat().st_mtime)
                    .astimezone()
                    .isoformat(),
                    "duration_seconds": _duration(path),
                }
            )
    if kind in {"all", "speech"}:
        for path in tts.SPEECH_DIR.glob("speech_*.json"):
            try:
                metadata = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            entries.append(
                {
                    "kind": "speech",
                    "id": metadata.get("id", path.stem.removeprefix("speech_")),
                    "created_at": metadata.get("created_at"),
                    "duration_seconds": metadata.get("duration_seconds"),
                    "status": metadata.get("status", "unknown"),
                    "voices": sorted(
                        {
                            str(line.get("voice") or tts.DEFAULT_KOKORO_VOICE)
                            for line in metadata.get("lines", [])
                        }
                    ),
                }
            )
    entries.sort(key=lambda entry: entry.get("created_at") or "", reverse=True)
    return entries[: max(1, min(limit, 50))]


def resolve_audio(kind: str, audio_id: str = "latest") -> Path:
    if kind == "recording":
        root = audio.RECORDINGS_DIR
        if audio_id == "latest":
            path = root / "latest.wav"
        else:
            stem = audio_id if audio_id.startswith("clip_") else f"clip_{audio_id}"
            path = root / f"{stem}.wav"
    elif kind == "speech":
        root = tts.SPEECH_DIR
        if audio_id == "latest":
            candidates = []
            for metadata_path in root.glob("speech_*.json"):
                try:
                    metadata = json.loads(metadata_path.read_text())
                except (OSError, json.JSONDecodeError):
                    continue
                audio_path = metadata_path.with_suffix(".wav")
                if metadata.get("status") == "completed" and audio_path.exists():
                    candidates.append(audio_path)
            candidates.sort(key=lambda item: item.stat().st_mtime)
            if not candidates:
                raise ValueError("no generated speech found")
            path = candidates[-1]
        else:
            stem = audio_id if audio_id.startswith("speech_") else f"speech_{audio_id}"
            path = root / f"{stem}.wav"
    else:
        raise ValueError("kind must be recording or speech")

    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"audio not found: {kind}/{audio_id}") from exc
    if resolved.parent != root.resolve():
        raise ValueError("audio id points outside the agyspeak cache")
    return resolved
