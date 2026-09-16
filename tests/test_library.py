import json
import wave
from pathlib import Path

import pytest

from agyspeak import library


def _wav(path: Path, frames: int = 8000, rate: int = 16000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * frames)


def test_lists_recordings_and_speech(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    recordings = tmp_path / "recordings"
    speech = tmp_path / "speech"
    recording = recordings / "clip_20260916-120000.wav"
    generated = speech / "speech_20260916-120100.wav"
    _wav(recording)
    _wav(generated)
    generated.with_suffix(".json").write_text(
        json.dumps(
            {
                "id": "20260916-120100",
                "created_at": "2026-09-16T12:01:00+03:00",
                "status": "completed",
                "duration_seconds": 0.5,
                "lines": [{"text": "Hi", "voice": "Ryan"}],
            }
        )
    )
    monkeypatch.setattr(library.audio, "RECORDINGS_DIR", recordings)
    monkeypatch.setattr(library.tts, "SPEECH_DIR", speech)

    entries = library.list_audio()

    by_kind = {entry["kind"]: entry for entry in entries}
    assert by_kind["speech"]["voices"] == ["Ryan"]
    assert by_kind["recording"]["duration_seconds"] == 0.5


def test_resolves_latest_recording_without_allowing_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recordings = tmp_path / "recordings"
    recording = recordings / "clip_20260916-120000.wav"
    _wav(recording)
    (recordings / "latest.wav").symlink_to(recording.name)
    monkeypatch.setattr(library.audio, "RECORDINGS_DIR", recordings)

    assert library.resolve_audio("recording") == recording
    with pytest.raises(ValueError):
        library.resolve_audio("recording", "../../outside")


def test_latest_speech_ignores_failed_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    speech = tmp_path / "speech"
    completed = speech / "speech_old.wav"
    failed = speech / "speech_new.wav"
    _wav(completed)
    _wav(failed)
    completed.with_suffix(".json").write_text(json.dumps({"status": "completed"}))
    failed.with_suffix(".json").write_text(json.dumps({"status": "failed"}))
    monkeypatch.setattr(library.tts, "SPEECH_DIR", speech)

    assert library.resolve_audio("speech") == completed
