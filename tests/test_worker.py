import os
import json
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
import numpy as np

from agyspeak import player, tts, worker


def test_speech_client_requires_harness(monkeypatch) -> None:
    monkeypatch.delenv(worker.SOCKET_ENV, raising=False)

    with pytest.raises(RuntimeError, match="running agyspeak harness"):
        worker.ensure_running()


def test_harness_service_owns_and_removes_socket(monkeypatch) -> None:
    monkeypatch.delenv(worker.SOCKET_ENV, raising=False)
    socket_path = Path("/tmp") / f"agyspeak-test-{uuid4().hex}.sock"
    service = worker.HarnessSpeechService(socket_path)

    service.start()
    try:
        state = worker.status()
        assert socket_path.exists()
        assert os.environ[worker.SOCKET_ENV] == str(socket_path)
        assert state["pid"] == os.getpid()
        assert state["active"] is None
        assert state["loaded"] == {"kokoro": [], "qwen": [], "kokoro-sv": []}
    finally:
        service.close()

    assert not socket_path.exists()
    assert worker.SOCKET_ENV not in os.environ


@pytest.fixture
def streaming_service(monkeypatch, tmp_path):
    monkeypatch.delenv(worker.SOCKET_ENV, raising=False)
    monkeypatch.setattr(tts, 'SPEECH_DIR', tmp_path)
    monkeypatch.setattr(tts, '_limit_render_threads', lambda: None)
    completed = threading.Event()
    finish = player._finish_metadata
    def finish_metadata(*args, **kwargs):
        finish(*args, **kwargs)
        completed.set()
    monkeypatch.setattr(player, '_finish_metadata', finish_metadata)
    service = worker.HarnessSpeechService(Path('/tmp') / f'agyspeak-stream-{uuid4().hex}.sock')
    with service:
        yield completed


def test_stream_plays_before_finish_and_renders_next_chunk_during_playback(
    monkeypatch, tmp_path, streaming_service,
):
    first_playing = threading.Event()
    release_first = threading.Event()
    second_rendered = threading.Event()
    played = []
    cancel_events = []
    def render(line):
        if line['text'] == 'Second':
            second_rendered.set()
        return np.ones(240, dtype=np.float32)
    def play(path, stop_event=None):
        played.append(path)
        cancel_events.append(stop_event)
        if len(played) == 1:
            first_playing.set()
            assert release_first.wait(5)
    monkeypatch.setattr(tts, '_render_line', render)
    monkeypatch.setattr(tts, 'play', play)
    stream = player.NarrationStream()
    try:
        stream.append([{'text': 'First', 'voice': 'af_heart'}])
        assert first_playing.wait(5), 'playback waited for the whole reply'
        stream.append([{'text': 'Second', 'voice': 'Klara', 'language': 'sv'}])
        assert second_rendered.wait(5), 'synthesis did not overlap playback'
        assert not cancel_events[0].is_set(), 'appending cancelled the first paragraph'
        stream.finish()
    finally:
        release_first.set()
    assert streaming_service.wait(5)
    metadata = json.loads(stream.path.read_text())
    assert metadata['status'] == 'completed'
    assert [line['text'] for line in metadata['lines']] == ['First', 'Second']
    assert stream.path.with_suffix('.wav').exists()
    assert len(played) == 2
    assert list(tmp_path.glob('speech_*.json')) == [stream.path]


def test_stopping_stream_wakes_waiting_renderer_and_rejects_future_chunks(monkeypatch, streaming_service):
    monkeypatch.setattr(tts, 'play', lambda *args, **kwargs: pytest.fail('cancelled stream must not play'))
    stream = player.NarrationStream()
    deadline = time.monotonic() + 5
    while worker.status()['active'] != 'stream' and time.monotonic() < deadline:
        time.sleep(0.01)
    assert worker.stop()
    assert streaming_service.wait(5), 'renderer stayed blocked waiting for text'
    stream.append([{'text': 'must never be spoken', 'voice': 'af_heart'}])
    assert stream.closed
    assert json.loads(stream.path.read_text())['status'] == 'cancelled'
