from pathlib import Path

from agyspeak.backend import AgyClient, DEFAULT_MODEL, UNBOUNDED_PRINT_TIMEOUT


def test_build_prompt_attaches_absolute_audio_path(tmp_path: Path) -> None:
    clip = tmp_path / "clip.wav"
    prompt = AgyClient.build_prompt("hello", clip)
    assert prompt == f"hello @{clip.resolve()}"


def test_first_turn_argv_uses_model_and_print_mode() -> None:
    client = AgyClient(model=DEFAULT_MODEL)
    argv = client._argv("hi")
    assert argv[0] == "agy"
    assert "--model" in argv and DEFAULT_MODEL in argv
    assert "--conversation" not in argv
    timeout_index = argv.index("--print-timeout")
    assert argv[timeout_index + 1] == UNBOUNDED_PRINT_TIMEOUT
