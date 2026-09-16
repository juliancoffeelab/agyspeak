"""Persistent local speech worker and its Unix-socket client."""

from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from agyspeak import tts

SOCKET_PATH = tts.SPEECH_DIR / "worker.sock"
PID_FILE = tts.SPEECH_DIR / "worker.pid"
LOG_FILE = tts.SPEECH_DIR / "worker.log"


def _request(payload: dict, timeout: float = 2.0) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(SOCKET_PATH))
        client.sendall(json.dumps(payload).encode() + b"\n")
        data = b""
        while chunk := client.recv(4096):
            data += chunk
    return json.loads(data)


def _available() -> bool:
    try:
        return _request({"command": "ping"}, timeout=0.2).get("ok") is True
    except (OSError, ValueError, json.JSONDecodeError):
        return False


def ensure_running() -> None:
    if _available():
        return
    tts.SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)
    with LOG_FILE.open("ab") as log:
        subprocess.Popen(
            [sys.executable, "-m", "agyspeak.worker", "serve"],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if _available():
            return
        time.sleep(0.05)
    raise RuntimeError(f"speech worker did not start; see {LOG_FILE}")


def submit_script(path: Path) -> None:
    ensure_running()
    response = _request({"command": "play", "script": str(path)})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech worker rejected the request"))


def replay(path: Path) -> None:
    ensure_running()
    response = _request({"command": "replay", "path": str(path)})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech worker rejected the replay"))


def stop() -> bool:
    if not _available():
        return False
    return bool(_request({"command": "stop"}).get("stopped"))


def shutdown() -> bool:
    if not _available():
        return False
    _request({"command": "shutdown"})
    deadline = time.monotonic() + 2.0
    while (PID_FILE.exists() or SOCKET_PATH.exists()) and time.monotonic() < deadline:
        time.sleep(0.05)
    return True


class _Jobs:
    def __init__(self) -> None:
        self.pending: queue.Queue[dict] = queue.Queue()
        self.lock = threading.Lock()
        self.current_cancel: threading.Event | None = None
        self.stopping = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, job: dict) -> bool:
        replaced = self.stop()
        self.pending.put(job)
        return replaced

    def stop(self) -> bool:
        stopped = False
        with self.lock:
            if self.current_cancel is not None:
                self.current_cancel.set()
                stopped = True
        while True:
            try:
                job = self.pending.get_nowait()
            except queue.Empty:
                break
            self._cancel_pending(job)
            stopped = True
        return stopped

    def close(self) -> None:
        self.stopping.set()
        self.stop()

    @staticmethod
    def _cancel_pending(job: dict) -> None:
        if job["kind"] != "script":
            return
        from agyspeak import player

        path = Path(job["path"])
        try:
            script = json.loads(path.read_text())
            player._finish_metadata(path, script, "cancelled")
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    def _run(self) -> None:
        while not self.stopping.is_set():
            try:
                job = self.pending.get(timeout=0.2)
            except queue.Empty:
                continue
            cancel = threading.Event()
            with self.lock:
                self.current_cancel = cancel
            try:
                self._run_one(job, cancel)
            finally:
                with self.lock:
                    self.current_cancel = None

    @staticmethod
    def _run_one(job: dict, cancel: threading.Event) -> None:
        from agyspeak import player

        path = Path(job["path"])
        if job["kind"] == "replay":
            try:
                tts.play(path, stop_event=cancel)
            except tts.SpeechCancelled:
                pass
            return

        script = json.loads(path.read_text())
        script["status"] = "rendering"
        path.write_text(json.dumps(script, indent=2) + "\n")
        try:
            player.play_lines(
                script["lines"],
                pause=float(script.get("pause", 0.4)),
                output_path=path.with_suffix(".wav"),
                stop_event=cancel,
            )
        except tts.SpeechCancelled:
            player._finish_metadata(path, script, "cancelled")
        except Exception as exc:
            player._finish_metadata(path, script, "failed", str(exc))
        else:
            player._finish_metadata(path, script, "completed")


def _reply(connection: socket.socket, payload: dict) -> None:
    connection.sendall(json.dumps(payload).encode())


def serve() -> None:
    tts.SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)
    jobs = _Jobs()
    shutting_down = False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(SOCKET_PATH))
        os.chmod(SOCKET_PATH, 0o600)
        server.listen()
        server.settimeout(0.2)
        PID_FILE.write_text(str(os.getpid()))
        try:
            while not shutting_down:
                try:
                    connection, _ = server.accept()
                except TimeoutError:
                    continue
                with connection:
                    try:
                        payload = json.loads(connection.makefile().readline())
                        command = payload.get("command")
                        if command == "ping":
                            _reply(connection, {"ok": True})
                        elif command in {"play", "replay"}:
                            key = "script" if command == "play" else "path"
                            jobs.submit(
                                {
                                    "kind": "script" if command == "play" else "replay",
                                    "path": payload[key],
                                }
                            )
                            _reply(connection, {"ok": True})
                        elif command == "stop":
                            _reply(connection, {"ok": True, "stopped": jobs.stop()})
                        elif command == "shutdown":
                            jobs.close()
                            _reply(connection, {"ok": True})
                            shutting_down = True
                        else:
                            _reply(connection, {"ok": False, "error": "unknown command"})
                    except Exception as exc:
                        _reply(connection, {"ok": False, "error": str(exc)})
        finally:
            jobs.close()
            SOCKET_PATH.unlink(missing_ok=True)
            PID_FILE.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "serve":
        serve()
        return
    raise SystemExit("usage: python -m agyspeak.worker serve")


if __name__ == "__main__":
    main()
