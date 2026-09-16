from types import SimpleNamespace

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
