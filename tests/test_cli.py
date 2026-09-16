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
