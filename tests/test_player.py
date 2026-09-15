from pathlib import Path

import pytest

from agyspeak import player


def test_qwen_script_renders_fully_before_playback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip = tmp_path / "narration.wav"
    calls = []

    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate",
        lambda lines, pause: calls.append(("render", lines, pause)) or clip,
    )
    monkeypatch.setattr(player.tts, "play", lambda path: calls.append(("play", path)))
    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate_streaming",
        lambda *args, **kwargs: pytest.fail("Qwen scripts must not stream"),
    )
    lines = [{"text": "Narrator", "voice": "af_heart"}, {"text": "Hello", "voice": "Ryan"}]

    player.play_lines(lines, pause=0.2)

    assert calls == [("render", lines, 0.2), ("play", clip)]


def test_kokoro_only_script_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    lines = [{"text": "Hello", "voice": "af_heart"}]

    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate_streaming",
        lambda actual, pause: calls.append((actual, pause)),
    )
    monkeypatch.setattr(
        player.tts,
        "kokoro_narrate",
        lambda *args, **kwargs: pytest.fail("Kokoro-only scripts should stream"),
    )

    player.play_lines(lines, pause=0.3)

    assert calls == [(lines, 0.3)]
