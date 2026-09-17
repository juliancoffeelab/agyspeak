import os
from pathlib import Path
from uuid import uuid4

import pytest

from agyspeak import worker


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
        assert state["loaded"] == {"kokoro": [], "qwen": []}
    finally:
        service.close()

    assert not socket_path.exists()
    assert worker.SOCKET_ENV not in os.environ
