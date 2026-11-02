import base64
import json
import sys
import time
from pathlib import Path

import pytest

from agyspeak import backend
from agyspeak.backend import AgyClient, DEFAULT_MODEL
from agyspeak.events import AudioPart, AuthenticationRequired, TextDelta, ToolProgress
from agyspeak.acp import ConnectionState
from agyspeak.sessions import SessionPreferences


@pytest.fixture(autouse=True)
def isolated_backend(monkeypatch, tmp_path):
    monkeypatch.setattr(backend, 'TURN_LOG_DIR', tmp_path / 'turns')
    monkeypatch.setattr(backend, 'AGY_WORKSPACE', tmp_path / 'workspace')
    monkeypatch.setattr(backend, 'ACP_DIAGNOSTIC_LOG', tmp_path / 'acp.log')
    monkeypatch.setattr(backend, 'resolve_binary', lambda binary=None: binary or '/usr/bin/false')


@pytest.fixture
def fake_agent(tmp_path):
    clients = []
    def make(**settings):
        script = tmp_path / f'agent-{len(clients)}'
        script.write_text(f'#!{sys.executable}\n' + (Path(__file__).parent / 'fixtures/acp_agent.py').read_text())
        script.chmod(0o755)
        script.with_suffix('.json').write_text(json.dumps(settings))
        # Tests explicitly authorize cleanup of their own fake processes.
        client = AgyClient(binary=str(script), on_force_stop=lambda: True)
        clients.append(client)
        def requests():
            return [json.loads(line) for line in script.with_suffix('.jsonl').read_text().splitlines()]
        return client, requests
    yield make
    for client in clients:
        client.close()


def test_audio_prompt_requests_native_viewing_with_spaces(tmp_path):
    clip = tmp_path / 'recording with spaces.wav'
    prompt = AgyClient.build_prompt('hello', clip)
    assert prompt.startswith('hello\n\n')
    assert f'Audio recording: "{clip.resolve()}"' in prompt
    assert 'native file-viewing tool' in prompt
    assert 'Do not use shell commands' in prompt


def test_text_only_prompt_is_unmodified():
    assert AgyClient.build_prompt('  hello  ', None) == 'hello'


def test_streaming_reuses_process_and_session_without_repeating_preamble(fake_agent):
    client, requests = fake_agent()
    events = []
    first = client.send('hello', on_event=events.append)
    process = client._connection.process
    second = client.send('again')
    assert first.response == second.response == 'Hej!'
    assert first.status == 'end_turn'
    assert first.usage['total_tokens'] == 42
    assert first.conversation_id == 'acp-chat'
    assert client._connection.process is process
    methods = [r.get('method') for r in requests()]
    assert methods.count('initialize') == methods.count('session/new') == 1
    prompts = [r['params']['prompt'] for r in requests() if r.get('method') == 'session/prompt']
    assert client.preamble in prompts[0][0]['text']
    assert prompts[1] == [{'type': 'text', 'text': 'again'}]
    assert 'PRIVATE THOUGHT' not in first.response
    assert first.log_path != second.log_path
    assert 'agent_message_chunk' in first.log_path.read_text()
    assert [e.text for e in events if isinstance(e, TextDelta)] == ['Hej', '!']
    initialized = next(r for r in requests() if r.get('method') == 'initialize')
    assert initialized['params']['clientCapabilities'] == {}
    changes = [r['params'] for r in requests() if r.get('method') == 'session/set_config_option']
    assert [(c['configId'], c['value']) for c in changes] == [
        ('model', DEFAULT_MODEL), ('thinking_level', 'medium'), ('mode', 'default'),
    ]


def test_native_audio_is_sent_as_bytes_without_path_hack(fake_agent, tmp_path):
    client, requests = fake_agent()
    clip = tmp_path / 'recording with spaces.mp3'
    clip.write_bytes(b'fake audio')
    client.send('', clip)
    blocks = next(r['params']['prompt'] for r in requests() if r.get('method') == 'session/prompt')
    assert blocks[1] == {'type': 'audio', 'mimeType': 'audio/mpeg', 'data': base64.b64encode(b'fake audio').decode()}
    assert 'Audio recording:' not in blocks[0]['text']
    assert backend.DEFAULT_VOICE_PROMPT in blocks[0]['text']


def test_audio_capability_absent_uses_file_path(fake_agent, tmp_path):
    client, requests = fake_agent(audio=False)
    clip = tmp_path / 'clip.mp3'
    clip.write_bytes(b'fake')
    client.send('Listen', clip)
    blocks = next(r['params']['prompt'] for r in requests() if r.get('method') == 'session/prompt')
    assert len(blocks) == 1
    assert str(clip) in blocks[0]['text']
    assert 'native file-viewing tool' in blocks[0]['text']


@pytest.mark.parametrize('load', [False, True])
def test_saved_session_resumes_without_replaying_history_or_preamble(fake_agent, load):
    client, requests = fake_agent(load=load)
    client.conversation_id = 'existing-chat'
    assert client.send('Continue').response == 'Hej!'
    methods = [r.get('method') for r in requests()]
    assert ('session/load' if load else 'session/resume') in methods
    assert 'session/new' not in methods
    prompt = next(r['params'] for r in requests() if r.get('method') == 'session/prompt')
    assert prompt['sessionId'] == 'existing-chat'
    assert prompt['prompt'] == [{'type': 'text', 'text': 'Continue'}]


def test_missing_saved_session_is_not_silently_replaced(fake_agent):
    client, requests = fake_agent(missing=True)
    client.conversation_id = 'missing-chat'
    with pytest.raises(RuntimeError, match='Session not found'):
        client.send('Continue')
    assert client.conversation_id == 'missing-chat'
    assert 'session/new' not in [r.get('method') for r in requests()]


def test_authentication_uses_native_personal_flow_once(fake_agent):
    client, requests = fake_agent(auth=True)
    client.send('hello')
    auth = [r for r in requests() if r.get('method') == 'authenticate']
    assert len(auth) == 1
    assert auth[0]['params'] == {'methodId': 'oauth-personal'}


@pytest.mark.parametrize('allow', [False, True])
def test_permission_response_uses_user_choice_and_does_not_retry_prompt(fake_agent, allow):
    client, requests = fake_agent(permission=True)
    client.on_permission = lambda params: allow
    turn = client.send('hello')
    response = next(r for r in requests() if r.get('id') == 'permission-1')
    assert response['result']['outcome'] == {'outcome': 'selected', 'optionId': 'yes' if allow else 'no'}
    assert bool(turn.denied_actions) == (not allow)
    assert sum(r.get('method') == 'session/prompt' for r in requests()) == 1


def test_permissions_default_to_reject_and_unknown_client_methods_are_unsupported(fake_agent):
    client, requests = fake_agent(permission=True, unknown_request=True)
    assert client.send('hello').denied_actions
    reply = next(r for r in requests() if r.get('id') == 'unknown')
    assert reply['error']['code'] == -32601


def test_yolo_is_explicit_and_model_switch_uses_config(fake_agent):
    client, requests = fake_agent(permission=True)
    client.yolo = True
    assert not client.send('hello').denied_actions
    client.model = 'other-model'
    client.send('again')
    changes = [r['params'] for r in requests() if r.get('method') == 'session/set_config_option']
    assert any(c['configId'] == 'mode' and c['value'] == 'yolo' for c in changes)
    assert changes[-1]['value'] == 'other-model'


def test_model_listing_and_unavailable_model_do_not_run_inference(fake_agent):
    client, requests = fake_agent()
    assert client.models() == [DEFAULT_MODEL, 'other-model']
    assert client.conversation_id is None
    client.model = 'missing'
    with pytest.raises(ValueError, match='unavailable'):
        client.send('hello')
    assert not any(r.get('method') == 'session/prompt' for r in requests())


def test_reset_starts_new_session_and_reapplies_preamble(fake_agent):
    client, requests = fake_agent()
    client.send('hello')
    client.reset()
    client.send('new chat')
    assert sum(r.get('method') == 'session/new' for r in requests()) == 2
    prompts = [r['params']['prompt'] for r in requests() if r.get('method') == 'session/prompt']
    assert all(client.preamble in p[0]['text'] for p in prompts)


def test_timeout_kills_runtime_that_ignores_termination(fake_agent):
    client, requests = fake_agent(hang=True)
    client.turn_timeout = 0.1
    with pytest.raises(TimeoutError):
        client.send('hello')
    assert client._connection.process.poll() is not None


def test_callback_interruption_stops_runtime(fake_agent):
    client, requests = fake_agent()
    def interrupt(event):
        if isinstance(event, (TextDelta, ToolProgress)):
            raise KeyboardInterrupt
    with pytest.raises(KeyboardInterrupt):
        client.send('hello', on_event=interrupt)
    assert client._connection.process.poll() is not None


def test_prompt_errors_are_not_retried(fake_agent):
    client, requests = fake_agent(prompt_error=True)
    with pytest.raises(RuntimeError, match='Model error'):
        client.send('hello')
    assert sum(r.get('method') == 'session/prompt' for r in requests()) == 1


def test_effort_uses_separate_advertised_thinking_level(fake_agent):
    client, requests = fake_agent()
    client.send('hello')
    client.effort = 'low'
    client.send('short answer please')
    client.effort = 'high'
    client.send('now think carefully')
    assert client.model == 'gemini-3.8-flash'
    config = [r['params'] for r in requests() if r.get('method') == 'session/set_config_option']
    assert [c['value'] for c in config if c['configId'] == 'thinking_level'] == ['medium', 'low', 'high']
    assert sum(r.get('method') == 'session/new' for r in requests()) == 1


def test_saved_cli_model_preference_is_mapped_to_acp_model_and_thinking_level(fake_agent):
    client, requests = fake_agent()
    client.model = 'gemini-3.8-flash-medium'
    assert client.effective_effort == 'medium'
    client.send('hello')
    assert client.model == 'gemini-3.8-flash'
    assert client.effective_effort == 'medium'
    config = [r['params'] for r in requests() if r.get('method') == 'session/set_config_option']
    assert any(c['configId'] == 'thinking_level' and c['value'] == 'medium' for c in config)


def test_runtime_diagnostics_are_logged_without_becoming_ui_events(fake_agent):
    dump = 'Sign in status: {"url": "https://example.com", "account": "internal"}'
    client, requests = fake_agent(diagnostic=dump, auth=True)
    events = []
    client.send('hello', on_event=events.append)
    client.close()
    assert dump in backend.ACP_DIAGNOSTIC_LOG.read_text()
    assert dump not in repr(events)
    assert AuthenticationRequired() in events


def test_model_listing_logs_startup_diagnostics_without_inference(fake_agent):
    client, requests = fake_agent(diagnostic='account status https://example.com')
    client.models()
    client.close()
    assert 'account status https://example.com' in backend.ACP_DIAGNOSTIC_LOG.read_text()
    assert not any(r.get('method') == 'session/prompt' for r in requests())


def test_timeout_also_applies_while_agent_continuously_streams(fake_agent):
    client, requests = fake_agent(stream_forever=True)
    client.turn_timeout = 0.05
    with pytest.raises(TimeoutError):
        client.send('hello')
    assert client._connection.process.poll() is not None


def test_runtime_exit_is_reported_without_retry(fake_agent):
    client, requests = fake_agent(crash=True)
    with pytest.raises(RuntimeError, match='exited during session/prompt') as error:
        client.send('hello')
    assert 'internal account info' not in str(error.value)
    assert str(backend.ACP_DIAGNOSTIC_LOG) in str(error.value)
    assert 'internal account info' in backend.ACP_DIAGNOSTIC_LOG.read_text()
    assert sum(r.get('method') == 'session/prompt' for r in requests()) == 1


def test_shutdown_stops_children_holding_pipes_after_parent_exits(fake_agent):
    client, requests = fake_agent(linger_child=True)
    approvals = []
    client.on_force_stop = lambda: approvals.append(True) or True
    client.send('hello')
    connection = client._connection
    started = time.monotonic()
    client.close()
    assert time.monotonic() - started < 5
    assert connection.process.poll() is not None
    assert all(not thread.is_alive() for thread in connection.readers)
    assert approvals == [True]
    connection.close()  # Closing twice must not signal a reused process group.


@pytest.mark.parametrize('save_child', [False, True])
def test_orderly_shutdown_allows_parent_and_child_to_finish_saving(fake_agent, save_child):
    client, requests = fake_agent(save_on_eof=True, save_child=save_child)
    client.send('hello')
    connection = client._connection
    signals = []
    original_signal = connection._signal_group
    def signal_group(sig):
        signals.append(sig)
        original_signal(sig)
    connection._signal_group = signal_group
    binary = Path(client.binary)
    client.close()
    assert binary.with_suffix('.saved').read_text() == 'saved on orderly exit'
    if save_child:
        assert binary.with_suffix('.child-saved').read_text() == 'child save complete'
    assert signals == []


@pytest.mark.parametrize('with_prompt', [False, True])
def test_shutdown_keeps_waiting_without_explicit_force_approval(fake_agent, with_prompt):
    client, requests = fake_agent(save_on_eof=True, save_child=True, save_delay=2.3)
    choices = []
    client.on_force_stop = (lambda: choices.append(False) or False) if with_prompt else None
    client.send('hello')
    connection = client._connection
    signals = []
    original_signal = connection._signal_group
    def signal_group(sig):
        signals.append(sig)
        original_signal(sig)
    connection._signal_group = signal_group
    client.close()
    assert Path(client.binary).with_suffix('.child-saved').read_text() == 'child save complete'
    assert signals == []
    assert choices == ([False] if with_prompt else [])


def test_interrupted_shutdown_is_retryable_and_connection_cannot_be_reused(fake_agent, monkeypatch):
    client, requests = fake_agent()
    client.send('hello')
    connection = client._connection
    wait = connection._wait_for_group
    def interrupt(timeout):
        raise KeyboardInterrupt
    monkeypatch.setattr(connection, '_wait_for_group', interrupt)
    with pytest.raises(KeyboardInterrupt):
        client.close()
    assert connection.state is ConnectionState.CLOSING
    assert not connection.usable
    with pytest.raises(RuntimeError, match='closing'):
        connection.request('session/new', {})
    monkeypatch.setattr(connection, '_wait_for_group', wait)
    assert client.send('continue').response == 'Hej!'
    assert connection.state is ConnectionState.CLOSED
    assert client._connection is not connection
    assert any(r.get('method') == 'session/resume' for r in requests())


def test_context_manager_closes_client_even_when_job_fails(fake_agent):
    client, requests = fake_agent()
    connection = None
    with pytest.raises(ValueError, match='job failed'):
        with client:
            client.send('hello')
            connection = client._connection
            raise ValueError('job failed')
    assert client._connection is None
    assert connection.state is ConnectionState.CLOSED
    assert connection.process.poll() is not None


def test_timeout_cancels_active_prompt_before_orderly_shutdown(fake_agent):
    client, requests = fake_agent(await_cancel=True)
    client.turn_timeout = 0.1
    approvals = []
    client.on_force_stop = lambda: approvals.append(True) or True
    with pytest.raises(TimeoutError):
        client.send('hello')
    assert any(r.get('method') == 'session/cancel' for r in requests())
    assert approvals == []


def test_interrupted_permission_prompt_returns_cancelled_outcome(fake_agent):
    client, requests = fake_agent(permission=True)
    def interrupt(params):
        raise KeyboardInterrupt
    client.on_permission = interrupt
    with pytest.raises(KeyboardInterrupt):
        client.send('hello')
    messages = requests()
    reply = next(r for r in messages if r.get('id') == 'permission-1')
    assert reply['result']['outcome'] == {'outcome': 'cancelled'}
    assert any(r.get('method') == 'session/cancel' for r in messages)


def test_second_interrupt_during_cancellation_still_closes_connection(fake_agent, monkeypatch):
    client, requests = fake_agent()
    connection = client._connect()
    def interrupt_cancel(*args):
        raise KeyboardInterrupt
    monkeypatch.setattr(connection, 'cancel', interrupt_cancel)
    def fail_callback(event):
        if isinstance(event, ToolProgress):
            raise RuntimeError('callback failed')
    with pytest.raises(KeyboardInterrupt):
        client.send('hello', on_event=fail_callback)
    assert connection.state is ConnectionState.CLOSED
    assert not connection.usable
    assert connection.process.poll() is not None


def test_effort_survives_saving_and_resuming(fake_agent, monkeypatch, tmp_path):
    from agyspeak import cli
    monkeypatch.setattr(cli, 'STATE_DIR', tmp_path)
    monkeypatch.setattr(cli, 'LAST_SESSION', tmp_path / 'last.json')
    monkeypatch.setattr(cli, 'SESSIONS', tmp_path / 'sessions.jsonl')
    first, _ = fake_agent()
    first.effort = 'high'
    with first:
        first.send('hello')
        cli._save_session(first)
        cli._log_session(first, 'test chat')
    saved = SessionPreferences.from_record(cli._load_session())
    indexed = SessionPreferences.from_record(cli._load_sessions()[0])
    assert saved == indexed == SessionPreferences('acp-chat', DEFAULT_MODEL, 'high')
    resumed, requests = fake_agent()
    with resumed:
        resumed.resume(saved)
        resumed.send('continue')
        assert resumed.preferences.effort == 'high'
        changes = [r['params'] for r in requests() if r.get('method') == 'session/set_config_option']
        assert not any(c['configId'] == 'thinking_level' and c['value'] == 'medium' for c in changes)


def test_permission_includes_tool_details_from_previous_updates(fake_agent):
    client, requests = fake_agent(permission=True, partial_permission=True)
    choices = []
    client.on_permission = lambda params: choices.append(params) or False
    client.send('hello')
    assert choices[0].title == 'Read recording'
    assert choices[0].arguments == {'Path': '/tmp/clip.wav'}


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
    monkeypatch.setattr(client, '_send_once', send_part)
    events = []
    result = client.send('Explain the Swedish words.', original, events.append)
    assert [call[1] for call in calls] == parts
    assert [call[2] for call in calls] == [None, 'same-chat', 'same-chat']
    assert 'final part 3/3' in calls[-1][0]
    assert 'Explain the Swedish words.' in calls[-1][0]
    assert result.response == 'Full answer.'
    assert [e.index for e in events if isinstance(e, AudioPart)] == [1, 2, 3]


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
    monkeypatch.setattr(client, '_send_once', send_part)
    result = client.send('Listen.', original)
    assert len(calls) == 1
    assert 'Stopped at audio part 1/2' in result.notes[-1]
