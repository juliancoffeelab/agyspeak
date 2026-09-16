import json
from pathlib import Path

import pytest

from agyspeak import player, worker


def test_qwen_script_renders_fully_before_playback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip = tmp_path / "narration.wav"
    calls = []

    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate",
        lambda lines, pause, output_path, stop_event: calls.append(
            ("render", lines, pause, output_path, stop_event)
        )
        or clip,
    )
    monkeypatch.setattr(
        player.tts,
        "play",
        lambda path, stop_event: calls.append(("play", path, stop_event)),
    )
    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate_streaming",
        lambda *args, **kwargs: pytest.fail("Qwen scripts must not stream"),
    )
    lines = [{"text": "Narrator", "voice": "af_heart"}, {"text": "Hello", "voice": "Ryan"}]

    result = player.play_lines(lines, pause=0.2, output_path=clip)

    assert result == clip
    assert calls == [("render", lines, 0.2, clip, None), ("play", clip, None)]


def test_kokoro_only_script_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    lines = [{"text": "Hello", "voice": "af_heart"}]

    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate_streaming",
        lambda actual, pause, output_path, stop_event: calls.append(
            (actual, pause, output_path, stop_event)
        )
        or clip,
    )
    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate",
        lambda *args, **kwargs: pytest.fail("Kokoro-only scripts should stream"),
    )

    clip = Path("speech.wav")
    result = player.play_lines(lines, pause=0.3, output_path=clip)

    assert result == clip
    assert calls == [(lines, 0.3, clip, None)]


def test_start_gives_metadata_and_audio_the_same_basename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(player.tts, "SPEECH_DIR", tmp_path)
    submitted = []
    monkeypatch.setattr(worker, "submit_script", submitted.append)

    script_path, _ = player.start([{"text": "Hello", "voice": "af_heart"}])
    metadata = json.loads(script_path.read_text())

    assert script_path.stem == Path(metadata["audio_file"]).stem
    assert metadata["status"] == "queued"
    assert metadata["lines"] == [{"text": "Hello", "voice": "af_heart"}]
    assert submitted == [script_path]
