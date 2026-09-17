import numpy as np
import pytest

from agyspeak import tts


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

    assert result is rendered
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

    assert result is rendered


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
