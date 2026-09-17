from types import SimpleNamespace

import numpy as np

from agyspeak import cli


class _Buffer:
    def __init__(self, text: str) -> None:
        self.text = text
        self.submitted = False

    def validate_and_handle(self) -> None:
        self.submitted = True


def _event(text: str) -> tuple[SimpleNamespace, _Buffer]:
    buffer = _Buffer(text)
    event = SimpleNamespace(app=SimpleNamespace(current_buffer=buffer))
    return event, buffer


def test_enter_on_empty_prompt_starts_audio() -> None:
    event, buffer = _event("")

    cli._submit_or_record(event)

    assert buffer.text == "/a"
    assert buffer.submitted


def test_enter_with_text_submits_text_unchanged() -> None:
    event, buffer = _event("hello")

    cli._submit_or_record(event)

    assert buffer.text == "hello"
    assert buffer.submitted


def test_cancelling_recording_leaves_no_background_stdin_reader(monkeypatch) -> None:
    class Recorder:
        sample_rate = 16000
        rms = 0.0
        elapsed = 0.1
        stopped = False

        def start(self) -> None:
            pass

        def stop(self) -> np.ndarray:
            self.stopped = True
            return np.zeros(16000, dtype=np.float32)

    recorder = Recorder()
    monkeypatch.setattr(cli.audio_mod, "Recorder", lambda device: recorder)
    monkeypatch.setattr(cli.sys, "stdin", SimpleNamespace(fileno=lambda: 42))
    monkeypatch.setattr(
        cli.select,
        "select",
        lambda *args: (_ for _ in ()).throw(KeyboardInterrupt),
    )

    assert cli._record(None) is None
    assert recorder.stopped


def test_recording_input_accepts_carriage_return(monkeypatch) -> None:
    monkeypatch.setattr(cli.select, "select", lambda *args: ([42], [], []))
    monkeypatch.setattr(cli.os, "read", lambda fd, size: b"\r")

    assert cli._recording_input(42) == "stop"


def test_recording_input_accepts_ctrl_c_byte(monkeypatch) -> None:
    monkeypatch.setattr(cli.select, "select", lambda *args: ([42], [], []))
    monkeypatch.setattr(cli.os, "read", lambda fd, size: b"\x03")

    assert cli._recording_input(42) == "cancel"


def test_voice_mode_warms_narrates_and_unloads(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(cli.worker, "warm", lambda voice: calls.append(("warm", voice)))
    monkeypatch.setattr(cli.player, "start", lambda lines, pause: calls.append(("start", lines, pause)))
    monkeypatch.setattr(cli.player, "unload", lambda: calls.append(("unload",)))

    mode = cli.VoiceMode(voice="bm_fable")
    mode.toggle()
    mode.narrate("**Hello.** How are you?")
    mode.toggle()

    assert calls[0] == ("warm", "bm_fable")
    assert calls[1][0] == "start"
    assert [line["text"] for line in calls[1][1]] == ["Hello. How are you?"]
    assert calls[1][1][0]["pause_before"] == 0.0
    assert calls[1][2] == 0.0
    assert calls[2] == ("unload",)


def test_voice_mode_notifies_persistence_after_state_changes(monkeypatch) -> None:
    states = []
    monkeypatch.setattr(cli.worker, "warm", lambda voice: None)
    monkeypatch.setattr(cli.player, "unload", lambda: None)
    monkeypatch.setattr(cli.tts, "kokoro_voices", lambda: ["af_heart", "am_echo"])
    mode = cli.VoiceMode()
    mode.on_change = lambda: states.append((mode.voice, mode.enabled))

    mode.toggle()
    mode.select("am_echo")
    mode.toggle()

    assert states == [
        ("af_heart", True),
        ("am_echo", True),
        ("am_echo", False),
    ]


def test_speech_commands_control_harness_models(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(cli.worker, "load", lambda engine, voice: calls.append(("load", engine, voice)))
    monkeypatch.setattr(cli.player, "unload", lambda engine: calls.append(("unload", engine)))
    monkeypatch.setattr(cli.player, "stop", lambda: True)

    assert "loading kokoro" in cli._speech_command("load", "bm_fable")
    assert "loading qwen" in cli._speech_command("load qwen", "bm_fable")
    assert "unloading kokoro" in cli._speech_command("unload kokoro", "bm_fable")
    assert "speech stopped" in cli._speech_command("stop", "bm_fable")
    assert calls == [
        ("load", "kokoro", "bm_fable"),
        ("load", "qwen", "bm_fable"),
        ("unload", "kokoro"),
    ]


def test_speech_status_shows_loaded_models_and_error(monkeypatch) -> None:
    monkeypatch.setattr(
        cli.worker,
        "status",
        lambda: {
            "active": None,
            "queued": 0,
            "loaded": {"kokoro": ["a"], "qwen": []},
            "last_error": "bad voice",
        },
    )

    result = cli._speech_command("status", "af_heart")

    assert "idle" in result
    assert "kokoro a" in result
    assert "last error" in result
