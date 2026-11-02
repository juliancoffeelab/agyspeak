"""Process-level transport checks using local peers, without provider requests."""

import sys
import time

import pytest

from agyspeak.acp import AcpConnection, ConnectionState


def test_request_timeout_covers_large_upload_to_peer_that_never_reads(tmp_path):
    peer = tmp_path / 'stalled-peer'
    peer.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(30)\n')
    peer.chmod(0o755)
    connection = AcpConnection(str(peer), tmp_path)
    connection.on_force_stop = lambda: True
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match='sending'):
            connection.request('session/prompt', {'sessionId': 'test', 'data': 'x' * 2_000_000}, timeout=0.05)
        # Includes the graceful shutdown window and explicitly approved cleanup.
        assert time.monotonic() - started < 5
        assert connection.state is ConnectionState.CLOSED
        assert connection.process.poll() is not None
    finally:
        connection.close()
