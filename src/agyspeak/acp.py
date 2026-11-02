"""Small synchronous ACP v1 transport over a persistent JSON-RPC subprocess."""

from __future__ import annotations

import json
import io
import os
import platform
import queue
import select
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from typing import BinaryIO, TextIO


class AcpError(RuntimeError):
    def __init__(self, error: dict):
        self.code = error.get("code")
        super().__init__(error.get("message", "ACP request failed"))


class ConnectionState(Enum):
    OPEN = "open"
    CLOSING = "closing"
    CLOSED = "closed"


class AcpConnection:
    def __init__(self, binary: str, cwd: Path, diagnostic_log: Path | None = None):
        self.diagnostic_log = diagnostic_log
        if diagnostic_log:
            diagnostic_log.parent.mkdir(parents=True, exist_ok=True)
            diagnostic_log.touch(mode=0o600, exist_ok=True)
        self.process = subprocess.Popen(
            [binary, *(["--uid="] if platform.system() == "Linux" else [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
            cwd=cwd, start_new_session=True,
        )
        # Unbuffered, nonblocking writes make the request deadline cover audio
        # uploads too, and closing stdin never has buffered data to flush.
        os.set_blocking(self.process.stdin.fileno(), False)
        self.messages: queue.Queue[tuple[str, str | None]] = queue.Queue()
        self.sequence = 0
        self.log: TextIO | None = None
        self.on_notification: Callable[[str, dict], None] = lambda method, params: None
        self.on_request: Callable[[str, dict], dict] | None = None
        self.on_force_stop: Callable[[], bool] | None = None
        self.readers = []
        self.state = ConnectionState.OPEN
        self._partial_write = False
        self._request_active = False
        for stream, pipe in (("stdout", self.process.stdout), ("stderr", self.process.stderr)):
            thread = threading.Thread(target=self._read, args=(stream, pipe), daemon=True)
            thread.start()
            self.readers.append(thread)

    @property
    def usable(self) -> bool:
        return self.state is ConnectionState.OPEN and self.process.poll() is None

    def _read(self, stream: str, pipe: BinaryIO) -> None:
        try:
            with io.BufferedReader(pipe) as reader:
                for raw_line in reader:
                    line = raw_line.decode("utf-8", errors="replace")
                    if stream == "stderr" and self.diagnostic_log:
                        with self.diagnostic_log.open("a", encoding="utf-8") as log:
                            log.write(line)
                    self.messages.put((stream, line))
        finally:
            pipe.close()
            self.messages.put((stream, None))

    def _write(self, message: dict, deadline: float | None = None) -> None:
        data = memoryview((json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False) + "\n").encode("utf-8"))
        try:
            while data:
                remaining = deadline - time.monotonic() if deadline is not None else None
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("Antigravity ACP request timed out while sending")
                _, writable, _ = select.select([], [self.process.stdin], [], remaining)
                if not writable:
                    raise TimeoutError("Antigravity ACP request timed out while sending")
                try:
                    written = os.write(self.process.stdin.fileno(), data[:65536])
                except BlockingIOError:
                    continue
                data = data[written:]
                self._partial_write = bool(data)
        except TimeoutError:
            raise
        except (BrokenPipeError, OSError) as exc:
            raise RuntimeError("Antigravity ACP connection closed") from exc

    def request(self, method: str, params: dict, timeout: float | None = None) -> dict:
        if not self.usable:
            raise RuntimeError(f"Antigravity ACP connection is {self.state.value} or disconnected")
        if self._request_active:
            raise RuntimeError("Antigravity ACP supports one request at a time")
        self._request_active = True
        self.sequence += 1
        request_id = self.sequence
        deadline = time.monotonic() + timeout if timeout is not None else None
        sent = False
        permission_id = None
        try:
            self._write({"id": request_id, "method": method, "params": params}, deadline)
            sent = True
            while True:
                remaining = deadline - time.monotonic() if deadline is not None else None
                if remaining is not None and remaining <= 0:
                    raise TimeoutError(f"Antigravity ACP timed out during {method}")
                try:
                    stream, line = self.messages.get(timeout=remaining)
                except queue.Empty:
                    raise TimeoutError(f"Antigravity ACP timed out during {method}") from None
                if line is None:
                    if stream == "stderr":
                        continue
                    details = f". Details: {self.diagnostic_log}" if self.diagnostic_log else ""
                    raise RuntimeError(f"Antigravity ACP exited during {method}{details}")
                if self.log:
                    self.log.write(line if stream == "stdout" else f"stderr: {line}")
                    self.log.flush()
                if stream == "stderr":
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RuntimeError("Invalid JSON from Antigravity ACP") from exc
                if "method" in message:
                    if "id" in message:
                        if self.on_request:
                            permission_id = message["id"] if message["method"] == "session/request_permission" else None
                            try:
                                result = self.on_request(message["method"], message.get("params", {}))
                            except AcpError as exc:
                                self._write({"id": message["id"], "error": {"code": exc.code, "message": str(exc)}}, deadline)
                            else:
                                self._write({"id": message["id"], "result": result}, deadline)
                            permission_id = None
                        else:
                            self._write({"id": message["id"], "error": {
                                "code": -32601, "message": "Client method not supported",
                            }}, deadline)
                    else:
                        self.on_notification(message["method"], message.get("params", {}))
                elif message.get("id") == request_id:
                    if "error" in message:
                        raise AcpError(message["error"])
                    return message.get("result") or {}
        except AcpError:
            raise
        except BaseException:
            # Shut down before returning from an interrupted or failed prompt.
            # Forced termination still requires the caller's confirmation.
            try:
                if sent and method == "session/prompt":
                    self.cancel(params["sessionId"], permission_id)
            finally:
                self.close()
            raise
        finally:
            self._request_active = False

    def cancel(self, session_id: str, permission_id: str | int | None = None) -> None:
        """Best-effort cancellation before EOF; never append to a partial upload."""
        if self._partial_write:
            return
        deadline = time.monotonic() + 0.2
        try:
            if permission_id is not None:
                self._write({"id": permission_id, "result": {"outcome": {"outcome": "cancelled"}}}, deadline)
            self._write({"method": "session/cancel", "params": {"sessionId": session_id}}, deadline)
        except (OSError, RuntimeError):
            pass

    def _signal_group(self, sig: int) -> None:
        try:
            os.killpg(self.process.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can return EPERM when the exited process's group is gone.
            # A still-running owned process must not hide a termination failure.
            if self.process.poll() is None:
                raise

    def _wait_for_group(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            self.process.poll()  # Reap the parent, including after an EOF exit.
            try:
                os.killpg(self.process.pid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                if self.process.poll() is not None:
                    return True
                # Some macOS executables deny signal-zero probes while alive.
                # Treat that as still running and allow the shutdown grace time.
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.02, remaining))

    def close(self) -> None:
        if self.state is ConnectionState.CLOSED:
            return
        # Interrupted cleanup stays CLOSING: it can be retried but never reused.
        self.state = ConnectionState.CLOSING
        # EOF asks the agent to shut down normally and finish its writes.
        try:
            self.process.stdin.close()
        except BrokenPipeError:
            pass
        # Children may still be saving after their parent exits. Time passing
        # never grants permission to terminate them.
        wait_seconds = 2
        while not self._wait_for_group(wait_seconds):
            if self.on_force_stop and self.on_force_stop():
                if not self._wait_for_group(0):
                    if self.diagnostic_log:
                        with self.diagnostic_log.open("a", encoding="utf-8") as log:
                            log.write("AGSpeak: user approved stopping the stalled ACP process group.\n")
                    self._signal_group(signal.SIGTERM)
                    if not self._wait_for_group(1):
                        self._signal_group(signal.SIGKILL)
                break
            wait_seconds = 5
        self.process.wait()
        for thread in self.readers:
            thread.join(timeout=1)
        self.state = ConnectionState.CLOSED
        # Output readers own their pipes. Closing a buffered pipe here can
        # block on a reader's lock if an independently spawned child holds it.
