import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from agyspeak import cli
from agyspeak.events import AuthenticationRequired, ToolProgress
from agyspeak.sessions import SessionPreferences


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


def test_display_path_shortens_home_directory() -> None:
    assert cli._display_path(Path.home() / ".cache" / "agyspeak" / "clip.wav") == (
        "~/.cache/agyspeak/clip.wav"
    )
    assert cli._display_path(Path("/tmp/clip.wav")) == "/tmp/clip.wav"


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
    assert calls[1][1][0]["speed"] == cli.VOICE_MODE_SPEED
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


def test_repeat_narrates_the_last_model_reply(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(cli.player, "start", lambda lines, pause: calls.append((lines, pause)))
    mode = cli.VoiceMode(voice="af_heart", enabled=True)

    result = cli._repeat_last("**Hello.** Still here.", mode)

    assert result == "[dim]replaying last model reply[/dim]"
    assert [line["text"] for line in calls[0][0]] == ["Hello. Still here."]
    assert calls[0][1] == 0.0


def test_repeat_requires_a_reply_and_voice_mode() -> None:
    assert "no model reply" in cli._repeat_last("", cli.VoiceMode(enabled=True))
    assert "voice mode is off" in cli._repeat_last("Hello", cli.VoiceMode())


def test_last_model_reply_survives_session_updates(monkeypatch, tmp_path) -> None:
    state_file = tmp_path / "last_session.json"
    monkeypatch.setattr(cli, "STATE_DIR", tmp_path)
    monkeypatch.setattr(cli, "LAST_SESSION", state_file)
    client = SimpleNamespace(preferences=SessionPreferences("conversation-1", "gemini-test", "high"), conversation_id="conversation-1")

    cli._save_session(client, cli.VoiceMode(enabled=True), "Last model reply")
    cli._save_session(client, cli.VoiceMode(voice="am_echo", enabled=False))

    state = cli._load_session()
    assert state["last_response"] == "Last model reply"
    assert state["voice"] == "am_echo"


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


def test_voice_mode_routes_swedish_and_returns_to_selected_voice(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(cli.player, 'start', lambda lines, pause: calls.append(lines))
    mode = cli.VoiceMode(voice='bm_fable', enabled=True)
    assert mode.narrate('In Swedish: <swedish>bokstaven S</swedish>. Now English.') is None
    assert [(line['text'], line['voice']) for line in calls[0]] == [
        ('In Swedish:', 'bm_fable'), ('bokstaven S', 'Klara'),
        ('. Now English.', 'bm_fable'),
    ]
    assert calls[0][1]['engine'] == 'auto'
    assert calls[0][1]['language'] == 'sv'


def test_tool_description_includes_file_and_read_range() -> None:
    path = Path.home() / '.cache/agyspeak/recordings/clip.wav'
    assert cli._tool_description(ToolProgress('call', 'read_file', {
            'Path': str(path), 'StartLine': 1, 'EndLine': 20, 'ByteOffset': 500,
        })) == 'read_file · ~/.cache/agyspeak/recordings/clip.wav · lines 1–20 · byte 500'


def test_tool_description_shows_command_without_interpreting_markup() -> None:
    assert cli._tool_description(ToolProgress('call', 'run_command', {'CommandLine': 'tail -n 20 [file]'})) == 'run_command · tail -n 20 [file]'
    assert cli._tool_description(ToolProgress('call', 'read_file', {})) == 'read_file'


def test_tool_description_shows_search_query_and_url() -> None:
    for tool, params in [
        ('search_web', {'query': 'Swedish pronunciation dvärgarnas'}),
        ('read_url_content', {'Url': 'https://example.com/svenska'}),
    ]:
        description = cli._tool_description(ToolProgress('call', tool, params))
        assert next(iter(params.values())) in description


def test_unknown_tool_shows_arguments_and_bounds_multiline_details() -> None:
    description = cli._tool_description(ToolProgress('call', 'new_tool', {
        'toolSummary': 'Look up a reference', 'request': {'term': 'hej'},
        'text': 'a long line\n' * 100,
    }))
    assert 'Look up a reference' in description
    assert 'request={"term": "hej"}' in description
    assert '\n' not in description
    assert len(description) <= len('new_tool · ') + 240
    assert description.endswith('…')


def test_send_prompts_for_permission_and_restores_callback(monkeypatch):
    from agyspeak.backend import Turn

    choices = []
    previous = lambda params: False
    client = SimpleNamespace(model='test', conversation_id=None, on_permission=previous)
    def send(text, clip, on_event):
        assert client.on_permission(ToolProgress('call', 'Read recording', {'Path': '/tmp/a.wav'}))
        return Turn(response='Hej!')
    client.send = send
    monkeypatch.setattr(cli.Confirm, 'ask', lambda *args, **kwargs: choices.append(kwargs) or True)
    monkeypatch.setattr(cli, '_render_turn', lambda *args: None)
    monkeypatch.setattr(cli, '_save_session', lambda *args: None)
    monkeypatch.setattr(cli, '_log_session', lambda *args: None)
    assert cli._send(client, 'hello', None, cli.VoiceMode()) == 'Hej!'
    assert choices[0]['default'] is False
    assert client.on_permission is previous


def test_notices_show_only_structured_sign_in_message(monkeypatch):
    import io
    from rich.console import Console

    output = io.StringIO()
    monkeypatch.setattr(cli, 'console', Console(file=output, width=120))
    cli._agent_notice({'event': 'diagnostic', 'text': 'Sign in info https://example.com {account dump}'})
    assert output.getvalue() == ''
    cli._agent_notice(AuthenticationRequired())
    assert output.getvalue().strip() == 'Sign in to Antigravity in your browser to continue.'


def test_force_stop_prompt_defaults_to_waiting(monkeypatch):
    choices = []
    monkeypatch.setattr(cli.Confirm, 'ask', lambda *args, **kwargs: choices.append(kwargs) or False)
    assert cli._confirm_force_stop() is False
    assert choices[0]['default'] is False


def test_interrupted_force_stop_prompt_keeps_waiting(monkeypatch):
    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt
    monkeypatch.setattr(cli.Confirm, 'ask', interrupt)
    assert cli._confirm_force_stop() is False


@pytest.mark.parametrize('options,expected_model,expected_effort', [
    (['-c'], 'gemini-3.8-flash', 'high'),
    (['-c', '--model=other-model', '--effort', 'low'], 'other-model', 'low'),
])
def test_resume_reports_saved_preferences_and_honors_explicit_overrides(
    monkeypatch, tmp_path, options, expected_model, expected_effort,
):
    import sys
    from typer.testing import CliRunner
    from agyspeak.backend import AgyClient

    last = tmp_path / 'last.json'
    last.write_text(json.dumps({'conversation_id': 'existing-chat', 'model': 'gemini-3.8-flash', 'effort': 'high'}))
    monkeypatch.setattr(cli, 'STATE_DIR', tmp_path)
    monkeypatch.setattr(cli, 'LAST_SESSION', last)
    monkeypatch.setattr(cli, 'SESSIONS', tmp_path / 'sessions.jsonl')
    commands = iter(['/model', '/effort medium', '/q'])
    monkeypatch.setattr(cli, 'PromptSession', lambda **kwargs: SimpleNamespace(prompt=lambda *args: next(commands)))
    service = SimpleNamespace(start=lambda: None, close=lambda: None)
    monkeypatch.setattr(cli.worker, 'HarnessSpeechService', lambda: service)
    monkeypatch.setattr(cli, 'AgyClient', lambda **kwargs: AgyClient(binary=sys.executable, **kwargs))
    result = CliRunner().invoke(cli.app, options)
    assert result.exit_code == 0, result.exception
    assert f'model: {expected_model} · effort: {expected_effort}' in result.output
    assert json.loads(last.read_text())['effort'] == 'medium'


def test_invalid_effort_is_rejected_before_client_startup(monkeypatch):
    from typer.testing import CliRunner
    def unexpected_start(**kwargs):
        raise AssertionError('client must not start')
    monkeypatch.setattr(cli, 'AgyClient', unexpected_start)
    result = CliRunner().invoke(cli.app, ['--effort', 'invalid'])
    assert result.exit_code == 2
    assert 'choose low, medium, or high' in result.output
