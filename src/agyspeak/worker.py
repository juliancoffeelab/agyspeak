"""Harness-owned speech service and its Unix-socket client."""

from __future__ import annotations

import json
import os
import queue
import socket
import threading
from contextlib import nullcontext
from pathlib import Path

from agyspeak import tts

SOCKET_ENV = "AGYSPEAK_SPEECH_SOCKET"


def _configured_socket() -> Path | None:
    value = os.environ.get(SOCKET_ENV)
    return Path(value) if value else None


def _request(payload: dict, timeout: float = 2.0, path: Path | None = None) -> dict:
    target = path or _configured_socket()
    if target is None:
        raise RuntimeError("speech tools require a running agyspeak harness")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(target))
        client.sendall(json.dumps(payload).encode() + b"\n")
        data = b""
        while chunk := client.recv(4096):
            data += chunk
    return json.loads(data)


def _available(path: Path | None = None) -> bool:
    try:
        return _request({"command": "ping"}, timeout=0.2, path=path).get("ok") is True
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
        return False


def ensure_running() -> None:
    """Require the private service owned by the current agyspeak harness."""
    if _available():
        return
    if _configured_socket() is None:
        raise RuntimeError("speech tools require a running agyspeak harness")
    raise RuntimeError("the agyspeak speech service is unavailable")


def submit_script(path: Path) -> None:
    ensure_running()
    response = _request({"command": "play", "script": str(path)})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech service rejected the request"))


def start_stream(path: Path) -> None:
    response = _request({"command": "stream_start", "path": str(path)})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "could not start narration"))


def append_stream(path: Path, lines: list[dict]) -> bool:
    response = _request({"command": "stream_append", "path": str(path), "lines": lines})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "could not append narration"))
    return response.get("accepted", False)


def finish_stream(path: Path, *, cancel: bool = False) -> None:
    response = _request({"command": "stream_finish", "path": str(path), "cancel": cancel})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "could not finish narration"))


def replay(path: Path) -> None:
    ensure_running()
    response = _request({"command": "replay", "path": str(path)})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech service rejected the replay"))


def stop() -> bool:
    if not _available():
        return False
    return bool(_request({"command": "stop"}).get("stopped"))


def load(engine: str, voice: str = tts.DEFAULT_KOKORO_VOICE) -> None:
    ensure_running()
    response = _request({"command": "load", "engine": engine, "voice": voice})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech service rejected model load"))


def warm(voice: str) -> None:
    """Compatibility name for loading the selected Kokoro voice."""
    load("kokoro", voice)


def unload(engine: str = "all") -> bool:
    if not _available():
        return False
    response = _request({"command": "unload", "engine": engine})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech service rejected model unload"))
    return True


def status() -> dict:
    ensure_running()
    response = _request({"command": "status"})
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "speech service status failed"))
    return response


class _SpeechStream:
    def __init__(self, path: Path):
        self.path = path
        self.script = json.loads(path.read_text())
        self.pending: queue.Queue[list[dict] | None] = queue.Queue()
        self.lock = threading.Lock()
        self.accepting = True
        self.cancel_event = threading.Event()

    def append(self, lines: list[dict]) -> bool:
        with self.lock:
            if not self.accepting:
                return False
            self.script["lines"].extend(lines)
            self.path.write_text(json.dumps(self.script, indent=2) + "\n")
            self.pending.put(lines)
            return True

    def finish(self, cancel: bool = False) -> None:
        with self.lock:
            if cancel:
                self.cancel_event.set()
            if self.accepting:
                self.accepting = False
                self.pending.put(None)

    def __iter__(self):
        while True:
            lines = self.pending.get()
            if lines is None or self.cancel_event.is_set():
                return
            for line in lines:
                if self.cancel_event.is_set():
                    return
                yield line


class _Jobs:
    def __init__(self) -> None:
        self.pending: queue.Queue[dict] = queue.Queue()
        self.lock = threading.Lock()
        self.current_cancel: threading.Event | None = None
        self.current_kind: str | None = None
        self.last_error: str | None = None
        self.stopping = threading.Event()
        self.stream: _SpeechStream | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, job: dict, replace: bool = True) -> bool:
        replaced = self.stop() if replace else False
        self.pending.put(job)
        return replaced

    def stop(self) -> bool:
        stopped = False
        with self.lock:
            if self.current_cancel is not None:
                self.current_cancel.set()
                stopped = True
            stream, self.stream = self.stream, None
        if stream:
            stream.finish(cancel=True)
            stopped = True
        while True:
            try:
                job = self.pending.get_nowait()
            except queue.Empty:
                break
            self._cancel_pending(job)
            stopped = True
        return stopped

    def start_stream(self, path: Path) -> None:
        self.stop()
        stream = _SpeechStream(path)
        with self.lock:
            self.stream = stream
        self.submit({"kind": "stream", "path": str(path), "stream": stream}, replace=False)

    def append_stream(self, path: Path, lines: list[dict]) -> bool:
        with self.lock:
            stream = self.stream
        return bool(stream and stream.path == path and stream.append(lines))

    def finish_stream(self, path: Path, cancel: bool = False) -> None:
        with self.lock:
            stream = self.stream
        if stream and stream.path == path:
            if cancel:
                self.stop()
            else:
                stream.finish()

    def close(self) -> None:
        self.stopping.set()
        self.stop()

    def state(self) -> dict:
        with self.lock:
            active = self.current_kind
            last_error = self.last_error
        return {
            "active": active,
            "queued": self.pending.qsize(),
            "loaded": tts.loaded_models(),
            "last_error": last_error,
        }

    @staticmethod
    def _cancel_pending(job: dict) -> None:
        if job["kind"] not in {"script", "stream"}:
            return
        from agyspeak import player

        path = Path(job["path"])
        if job["kind"] == "stream":
            job["stream"].finish(cancel=True)
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
            cancel = job["stream"].cancel_event if job.get("stream") else threading.Event()
            with self.lock:
                self.current_cancel = cancel
                self.current_kind = str(job["kind"])
                self.last_error = None
            try:
                self._run_one(job, cancel)
            except Exception as exc:
                with self.lock:
                    self.last_error = str(exc)
            finally:
                with self.lock:
                    self.current_cancel = None
                    self.current_kind = None
                    if job.get("stream") is self.stream:
                        self.stream = None

    @staticmethod
    def _run_one(job: dict, cancel: threading.Event) -> None:
        kind = job["kind"]
        if kind == "load":
            tts.load_model(str(job["engine"]), str(job.get("voice") or tts.DEFAULT_KOKORO_VOICE))
            return
        if kind == "unload":
            tts.unload_models(str(job.get("engine") or "all"))
            return

        from agyspeak import player

        path = Path(job["path"])
        if kind == "replay":
            try:
                tts.play(path, stop_event=cancel)
            except tts.SpeechCancelled:
                pass
            return

        stream = job.get("stream")
        script = stream.script if stream else json.loads(path.read_text())
        with stream.lock if stream else nullcontext():
            script["status"] = "rendering"
            path.write_text(json.dumps(script, indent=2) + "\n")
        status, error = "completed", None
        try:
            if stream:
                tts.kokoro_narrate_streaming(
                    stream, pause=0.0, output_path=path.with_suffix(".wav"),
                    stop_event=cancel, start_buffer_seconds=0.0,
                )
            else:
                player.play_lines(
                    script["lines"], pause=float(script.get("pause", 0.4)),
                    output_path=path.with_suffix(".wav"), stop_event=cancel,
                )
        except tts.SpeechCancelled:
            status = "cancelled"
        except tts.NoAudioError as exc:
            if script["lines"]:
                status, error = "failed", str(exc)
        except Exception as exc:
            status, error = "failed", str(exc)
        if stream and stream.cancel_event.is_set():
            status, error = "cancelled", None
        with stream.lock if stream else nullcontext():
            player._finish_metadata(path, script, status, error)


def _reply(connection: socket.socket, payload: dict) -> None:
    connection.sendall(json.dumps(payload).encode())


def serve(path: Path, ready: threading.Event | None = None) -> None:
    """Serve speech requests inside the harness process."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    jobs = _Jobs()
    shutting_down = False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(path))
        os.chmod(path, 0o600)
        server.listen()
        server.settimeout(0.2)
        if ready:
            ready.set()
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
                        elif command == "status":
                            _reply(connection, {"ok": True, "pid": os.getpid(), **jobs.state()})
                        elif command == "load":
                            jobs.submit(
                                {
                                    "kind": "load",
                                    "engine": payload.get("engine") or "kokoro",
                                    "voice": payload.get("voice") or tts.DEFAULT_KOKORO_VOICE,
                                },
                                replace=False,
                            )
                            _reply(connection, {"ok": True, "queued": True})
                        elif command == "unload":
                            jobs.submit(
                                {"kind": "unload", "engine": payload.get("engine") or "all"}
                            )
                            _reply(connection, {"ok": True, "queued": True})
                        elif command in {"play", "replay"}:
                            key = "script" if command == "play" else "path"
                            jobs.submit(
                                {
                                    "kind": "script" if command == "play" else "replay",
                                    "path": payload[key],
                                }
                            )
                            _reply(connection, {"ok": True})
                        elif command == "stream_start":
                            jobs.start_stream(Path(payload["path"]))
                            _reply(connection, {"ok": True})
                        elif command == "stream_append":
                            accepted = jobs.append_stream(Path(payload["path"]), payload["lines"])
                            _reply(connection, {"ok": True, "accepted": accepted})
                        elif command == "stream_finish":
                            jobs.finish_stream(Path(payload["path"]), cancel=payload.get("cancel", False))
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
            tts.unload_models()
            path.unlink(missing_ok=True)


class HarnessSpeechService:
    """Own the private speech service for one interactive agyspeak process."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or tts.SPEECH_DIR / f"harness-{os.getpid()}.sock"
        self.thread: threading.Thread | None = None
        self.previous_socket: str | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.previous_socket = os.environ.get(SOCKET_ENV)
        os.environ[SOCKET_ENV] = str(self.path)
        ready = threading.Event()
        self.thread = threading.Thread(target=serve, args=(self.path, ready), daemon=True)
        self.thread.start()
        if not ready.wait(3.0) or not _available(self.path):
            self.close()
            raise RuntimeError("could not start the agyspeak speech service")

    def close(self) -> None:
        thread = self.thread
        if thread and thread.is_alive() and _available(self.path):
            try:
                _request({"command": "shutdown"}, path=self.path)
            except OSError:
                pass
            thread.join(timeout=2.0)
        self.path.unlink(missing_ok=True)
        self.thread = None
        if self.previous_socket is None:
            os.environ.pop(SOCKET_ENV, None)
        else:
            os.environ[SOCKET_ENV] = self.previous_socket

    def __enter__(self) -> HarnessSpeechService:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
