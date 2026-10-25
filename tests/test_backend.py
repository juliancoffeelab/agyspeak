from pathlib import Path

from agyspeak.backend import AgyClient, DEFAULT_MODEL, UNBOUNDED_PRINT_TIMEOUT


def test_audio_prompt_requests_native_audio_viewing_even_with_spaces(tmp_path: Path) -> None:
    clip = tmp_path / 'recording with spaces.wav'
    prompt = AgyClient.build_prompt("hello", clip)
    assert prompt.startswith("hello\n\n")
    assert f'Audio recording: "{clip.resolve()}"' in prompt
    assert "native file-viewing tool" in prompt
    assert "returned native audio" in prompt
    assert "Do not use shell commands" in prompt
    assert "@/" not in prompt


def test_audio_only_prompt_has_default_request(tmp_path: Path) -> None:
    assert AgyClient.build_prompt("  ", tmp_path / "clip.wav").startswith(
        "Listen to this voice message and respond to it.\n\n"
    )


def test_text_only_prompt_is_unmodified() -> None:
    assert AgyClient.build_prompt("  hello  ", None) == "hello"


def test_first_turn_argv_uses_model_and_print_mode() -> None:
    client = AgyClient(model=DEFAULT_MODEL)
    argv = client._argv("hi")
    assert argv[0] == "agy"
    assert "--model" in argv and DEFAULT_MODEL in argv
    assert "--conversation" not in argv
    timeout_index = argv.index("--print-timeout")
    assert argv[timeout_index + 1] == UNBOUNDED_PRINT_TIMEOUT
