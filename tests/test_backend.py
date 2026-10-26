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
    assert "--sandbox" in argv
    assert "--conversation" not in argv
    timeout_index = argv.index("--print-timeout")
    assert argv[timeout_index + 1] == UNBOUNDED_PRINT_TIMEOUT


def test_turn_log_preserves_raw_events_and_diagnostics(monkeypatch, tmp_path: Path) -> None:
    import io
    import json
    from types import SimpleNamespace
    from agyspeak import backend

    raw = '\n  diagnostic message  \n' + '\n'.join([
        json.dumps({'event': 'init', 'conversation_id': 'example-conversation'}),
        json.dumps({'event': 'step_update', 'step_update': {
            'step_type': 'agent_response', 'text_delta': 'Hej!', 'thinking': 'separate field',
        }}),
        json.dumps({'event': 'result', 'result': {
            'response': 'Hej!', 'status': 'SUCCESS', 'conversation_id': 'example-conversation',
        }}),
    ]) + '\n'
    monkeypatch.setattr(backend, 'TURN_LOG_DIR', tmp_path / 'turns')
    monkeypatch.setattr(backend.subprocess, 'Popen', lambda *args, **kwargs: SimpleNamespace(
        stdout=io.StringIO(raw), wait=lambda: 0,
    ))
    events = []
    def on_event(event):
        events.append(event)
        # Output is flushed before callbacks, so partial turns survive interruption.
        assert list((tmp_path / 'turns').glob('*.log'))[0].read_text().endswith(
            json.dumps(event) + '\n'
        )
    client = AgyClient()
    first = client.send('hello', on_event=on_event)
    second = client.send('again')
    assert first.log_path != second.log_path
    assert first.log_path.read_text() == second.log_path.read_text() == raw
    assert first.response == 'Hej!'
    assert first.notes == ['diagnostic message']
    assert len(events) == 3


def test_empty_denied_turn_continues_once_in_same_conversation(monkeypatch) -> None:
    from agyspeak.backend import DENIAL_RECOVERY_PROMPT, Turn
    client = AgyClient()
    denied = Turn(conversation_id='same-chat', denied_actions=[{'action': 'RunCommand'}], duration=2)
    recovered = Turn(response='Here is the answer.', conversation_id='same-chat', duration=3)
    calls = []
    def send_once(text, audio=None, on_event=None):
        calls.append((text, audio, client.conversation_id, on_event))
        client.conversation_id = 'same-chat'
        return denied if len(calls) == 1 else recovered
    monkeypatch.setattr(client, '_send_once', send_once)
    callback = lambda event: None
    clip = Path('clip.wav')
    result = client.send('Listen', clip, callback)
    assert calls == [('Listen', clip, None, callback), (DENIAL_RECOVERY_PROMPT, None, 'same-chat', callback)]
    assert result.response == 'Here is the answer.'
    assert result.duration == 5
    assert result.denied_actions == denied.denied_actions


def test_repeated_denial_does_not_loop(monkeypatch) -> None:
    from agyspeak.backend import Turn
    client = AgyClient(conversation_id='same-chat')
    calls = []
    def send_once(*args, **kwargs):
        calls.append(args)
        return Turn(denied_actions=[{'action': 'RunCommand'}])
    monkeypatch.setattr(client, '_send_once', send_once)
    assert client.send('Listen').response == ''
    assert len(calls) == 2


def test_answer_with_denied_tool_is_not_retried(monkeypatch) -> None:
    from agyspeak.backend import Turn
    client = AgyClient(conversation_id='same-chat')
    turn = Turn(response='Already answered.', denied_actions=[{'action': 'RunCommand'}])
    calls = []
    monkeypatch.setattr(client, '_send_once', lambda *args, **kwargs: calls.append(args) or turn)
    assert client.send('Hello') is turn
    assert len(calls) == 1


def test_audio_parts_are_sent_in_order_before_final_answer(monkeypatch, tmp_path: Path):
    from agyspeak import audio as audio_module
    from agyspeak.backend import Turn
    original = tmp_path / 'long.wav'
    original.touch()
    parts = [tmp_path / f'part-{i}.wav' for i in range(3)]
    monkeypatch.setattr(audio_module, 'prepare_for_model', lambda path: parts)
    client = AgyClient()
    calls = []
    def send_part(text, audio, on_event):
        calls.append((text, audio, client.conversation_id))
        client.conversation_id = 'same-chat'
        return Turn(response=f'Received part {len(calls)}/3.' if len(calls) < 3 else 'Full answer.')
    monkeypatch.setattr(client, '_send_with_recovery', send_part)
    events = []
    result = client.send('Explain the Swedish words.', original, events.append)
    assert [call[1] for call in calls] == parts
    assert [call[2] for call in calls] == [None, 'same-chat', 'same-chat']
    assert 'final part 3/3' in calls[-1][0]
    assert 'Explain the Swedish words.' in calls[-1][0]
    assert result.response == 'Full answer.'
    assert [e['index'] for e in events] == [1, 2, 3]


def test_audio_part_failure_stops_remaining_parts(monkeypatch, tmp_path: Path):
    from agyspeak import audio as audio_module
    from agyspeak.backend import Turn
    original = tmp_path / 'long.wav'
    original.touch()
    monkeypatch.setattr(audio_module, 'prepare_for_model', lambda path: [Path('one.wav'), Path('two.wav')])
    client = AgyClient()
    calls = []
    def send_part(*args):
        calls.append(args)
        return Turn(response='This request was blocked by Gemini filters.')
    monkeypatch.setattr(client, '_send_with_recovery', send_part)
    result = client.send('Listen.', original)
    assert len(calls) == 1
    assert 'Stopped at audio part 1/2' in result.notes[-1]
