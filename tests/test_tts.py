import threading

import numpy as np
import pytest

from agyspeak import tts
from agyspeak.speech_text import narration_chunks


def test_qwen_speaker_selects_qwen(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    rendered = np.array([0.25, -0.25], dtype=np.float32)

    def fake_qwen(text, speaker, instruct, language):
        calls.append((text, speaker, instruct, language))
        return rendered, tts.KOKORO_RATE

    monkeypatch.setattr(tts, "qwen_render", fake_qwen)

    result = tts._render_line(
        {
            "text": "Careful now.",
            "voice": "Ryan",
            "instruct": "whispering",
            "language": "English",
        }
    )

    np.testing.assert_array_equal(result, rendered)
    assert calls == [("Careful now.", "Ryan", "whispering", "English")]


def test_kokoro_voice_stays_on_kokoro(monkeypatch: pytest.MonkeyPatch) -> None:
    rendered = np.array([0.5], dtype=np.float32)

    monkeypatch.setattr(tts, "kokoro_render", lambda text, voice, speed: rendered)
    monkeypatch.setattr(
        tts,
        "qwen_render",
        lambda *args, **kwargs: pytest.fail("Qwen should not render a Kokoro voice"),
    )

    result = tts._render_line({"text": "Hello.", "voice": "af_heart"})

    np.testing.assert_array_equal(result, rendered)


def test_explicit_qwen_defaults_to_ryan(monkeypatch: pytest.MonkeyPatch) -> None:
    speakers = []

    def fake_qwen(text, speaker, instruct, language):
        speakers.append(speaker)
        return np.array([0.0], dtype=np.float32), tts.KOKORO_RATE

    monkeypatch.setattr(tts, "qwen_render", fake_qwen)

    tts._render_line({"text": "Hello.", "engine": "qwen"})

    assert speakers == [tts.DEFAULT_QWEN_SPEAKER]


def test_auto_engine_uses_voice_to_select_qwen() -> None:
    assert tts.line_engine({"voice": "Ryan", "engine": "auto"}) == "qwen"


def test_line_pause_overrides_default_and_cannot_be_negative() -> None:
    assert tts.pause_before({}, 0.4) == 0.4
    assert tts.pause_before({"pause_before": 0.2}, 0.4) == 0.2
    assert tts.pause_before({"pause_before": -1}, 0.4) == 0.0


def test_qwen_registers_specific_transformers_config() -> None:
    from transformers import AutoConfig

    tts._register_qwen_transformers_config()

    assert AutoConfig.for_model("qwen3_tts").model_type == "qwen3_tts"


def test_trims_only_edge_silence(monkeypatch: pytest.MonkeyPatch) -> None:
    keep = int(tts.KOKORO_RATE * tts.EDGE_SILENCE_KEEP_SECONDS)
    audio = np.concatenate(
        [
            np.zeros(2000, dtype=np.float32),
            np.ones(100, dtype=np.float32),
            np.zeros(500, dtype=np.float32),
            np.ones(100, dtype=np.float32),
            np.zeros(2000, dtype=np.float32),
        ]
    )

    monkeypatch.setattr(tts, "kokoro_render", lambda text, voice, speed: audio)

    trimmed = tts._render_line({"text": "Hello"})

    assert len(trimmed) == 700 + 2 * keep
    assert np.count_nonzero(trimmed) == 200


def test_does_not_trim_an_entirely_silent_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = np.zeros(100, dtype=np.float32)
    monkeypatch.setattr(tts, "kokoro_render", lambda text, voice, speed: audio)

    rendered = tts._render_line({"text": "Hello"})

    assert rendered is audio


def test_streaming_buffers_past_a_short_heading_before_playback(
    monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    body_rendered = threading.Event()
    played: list[str] = []

    def fake_render(line: dict) -> np.ndarray:
        seconds = 1 if line["text"] == "Heading" else 5
        if line["text"] == "Body":
            body_rendered.set()
        return np.ones(tts.KOKORO_RATE * seconds, dtype=np.float32)

    def fake_play(path, stop_event=None) -> None:
        if not played:
            assert body_rendered.is_set()
        played.append(path.name)

    output = tmp_path / "joined.wav"
    monkeypatch.setattr(tts, "SPEECH_DIR", tmp_path)
    monkeypatch.setattr(tts, "_limit_render_threads", lambda: None)
    monkeypatch.setattr(tts, "_render_line", fake_render)
    monkeypatch.setattr(tts.sf, "write", lambda *args, **kwargs: None)
    monkeypatch.setattr(tts, "play", fake_play)
    monkeypatch.setattr(tts, "save", lambda audio, path=None: path)

    result = tts.kokoro_narrate_streaming(
        [
            {"text": "Heading", "pause_before": 0.0},
            {"text": "Body", "pause_before": 0.0},
        ],
        pause=0.0,
        output_path=output,
    )

    assert result == output
    assert played == ["seg_joined_000.wav", "seg_joined_001.wav"]


def test_streaming_warns_and_continues_after_an_empty_segment(
    monkeypatch: pytest.MonkeyPatch, tmp_path, caplog: pytest.LogCaptureFixture,
) -> None:
    played: list[str] = []

    def fake_render(line: dict) -> np.ndarray:
        if line["text"] == "/sɛd/":
            raise tts.NoAudioError("kokoro produced no audio")
        return np.ones(tts.KOKORO_RATE, dtype=np.float32)

    output = tmp_path / "pronunciation.wav"
    monkeypatch.setattr(tts, "SPEECH_DIR", tmp_path)
    monkeypatch.setattr(tts, "_limit_render_threads", lambda: None)
    monkeypatch.setattr(tts, "_render_line", fake_render)
    monkeypatch.setattr(tts.sf, "write", lambda *args, **kwargs: None)
    monkeypatch.setattr(tts, "play", lambda path, stop_event=None: played.append(path.name))
    monkeypatch.setattr(tts, "save", lambda audio, path=None: path)

    result = tts.kokoro_narrate_streaming(
        [
            {"text": "Before"},
            {"text": "/sɛd/"},
            {"text": "English spelling strikes again!"},
        ],
        pause=0.0,
        output_path=output,
    )

    assert result == output
    assert played == [
        "seg_pronunciation_000.wav",
        "seg_pronunciation_002.wav",
    ]
    assert "Skipping unrenderable speech segment '/sɛd/'" in caplog.text


def test_pronunciation_markdown_streams_past_ipa_table(
    monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    markdown = '''| Word | Expected | Actual | Rhymes With |
| --- | --- | --- | --- |
| said | /seɪd/ or /sæd/ | /sɛd/ | bed, red, head |
| says | /seɪz/ | /sɛz/ | fez, Pez |

English spelling strikes again!
'''
    rendered: list[str] = []
    played: list[str] = []

    def fake_render(line: dict) -> np.ndarray:
        text = line["text"]
        assert text not in {"/sɛd/", "/sɛz/"}
        rendered.append(text)
        return np.ones(tts.KOKORO_RATE, dtype=np.float32)

    output = tmp_path / "table.wav"
    monkeypatch.setattr(tts, "SPEECH_DIR", tmp_path)
    monkeypatch.setattr(tts, "_limit_render_threads", lambda: None)
    monkeypatch.setattr(tts, "_render_line", fake_render)
    monkeypatch.setattr(tts.sf, "write", lambda *args, **kwargs: None)
    monkeypatch.setattr(tts, "play", lambda path, stop_event=None: played.append(path.name))
    monkeypatch.setattr(tts, "save", lambda audio, path=None: path)

    lines = [{"text": chunk.text, "pause_before": 0.0} for chunk in narration_chunks(markdown)]
    result = tts.kokoro_narrate_streaming(lines, pause=0.0, output_path=output)

    assert result == output
    assert rendered == [
        "Word; Expected; Actual; Rhymes With",
        "said; /seɪd/ or /sæd/; /sɛd/; bed, red, head",
        "says; /seɪz/; /sɛz/; fez, Pez",
        "English spelling strikes again!",
    ]
    assert played[-1] == "seg_table_003.wav"
