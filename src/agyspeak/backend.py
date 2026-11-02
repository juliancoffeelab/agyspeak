"""Voice chat through Google's official Antigravity ACP runtime."""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from agyspeak.acp import AcpConnection, AcpError
from agyspeak.acp_runtime import RUNTIME_BINARY
from agyspeak.events import AudioPart, AuthenticationRequired, ChatEvent, TextDelta, ToolProgress
from agyspeak.sessions import DEFAULT_MODEL, EFFORT_LEVELS, SessionPreferences

TURN_LOG_DIR = Path.home() / ".cache" / "agyspeak" / "turns"
AGY_WORKSPACE = Path.home() / ".cache" / "agyspeak" / "workspace"
ACP_DIAGNOSTIC_LOG = Path.home() / ".cache" / "agyspeak" / "acp.log"

DEFAULT_VOICE_PROMPT = "Listen to this voice message and respond to it."
DEFAULT_PREAMBLE = """\
You are a general multimodal assistant talking with the user in a terminal chat. \
This is not a coding session. The user may type or send voice recordings, and you \
receive native audio attachments or a path to each recording. Listen to attached \
audio directly. For paths, open the recording with the native file-viewing tool \
(view_file, or read_file in some toolsets), which returns audio you can listen to. \
Do not use shell commands or external transcription tools to process recordings. \
A common use is language learning: transcribe or answer what was said, \
and when asked comment on pronunciation, accent, grammar, or word choice, with the \
level of detail the user asks for. Otherwise behave as a helpful conversational \
assistant on any topic. Do not use file or shell tools unless the user asks for \
something that needs them. If a `speak` tool is available, use it only when the \
user asks to hear something aloud. Output is rendered in a terminal Markdown \
viewer with no LaTeX support, so write formulas as plain text or Unicode instead \
of using LaTeX math delimiters or commands. Replies can be spoken automatically. \
Use scoped speech tags to select pronunciation and voices, for example \
<speak language="sv" voice="Klara">jag heter Anna</speak>. \
Attributes match the speak tool: voice, language, speed (0.5–1.5), engine, instruct. \
Swedish Kokoro voices include Klara and Viktor for ordinary prose, Elsa and Lars \
for literary readings. A Swedish voice name selects Swedish automatically. \
Use engine="say" voice="Alva" for the macOS Swedish voice. instruct is Qwen only. \
Keep English explanations outside Swedish scopes. Preserve poem line breaks \
inside a scope; use ordinary spelling, not IPA. For letter names give context, \
for example <speak language="sv">bokstaven S</speak>. Use IPA /.../ in English \
explanations for isolated sounds. Close every scope. Tags affect only their \
contents and are hidden in the text display; normal Markdown still works inside. \
Legacy <swedish>...</swedish> is also supported."""

@dataclass
class Turn:
    response: str = ""
    log_path: Path | None = None
    conversation_id: str | None = None
    status: str = ""
    usage: dict = field(default_factory=dict)
    denied_actions: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    duration: float = 0.0


class AgyNotFound(RuntimeError):
    pass


def resolve_binary(binary: str | None = None) -> str:
    requested = binary or os.environ.get("AGYSPEAK_ACP_BINARY")
    if requested:
        found = shutil.which(str(Path(requested).expanduser()))
    else:
        found = shutil.which("agy_acp_server.par") or (
            str(RUNTIME_BINARY) if os.access(RUNTIME_BINARY, os.X_OK) else None
        )
    if not found:
        raise AgyNotFound(
            "Official Antigravity ACP runtime not found. Install it with "
            "`uv run python -m agyspeak.acp_runtime` from the repository root, "
            "or set AGYSPEAK_ACP_BINARY to agy_acp_server.par."
        )
    return found


def _select_values(options: list[dict]) -> list[str]:
    values = []
    for option in options:
        if "options" in option:
            values.extend(_select_values(option["options"]))
        elif "value" in option:
            values.append(option["value"])
    return values


@dataclass
class AgyClient:
    model: str = DEFAULT_MODEL
    effort: str | None = None
    yolo: bool = False
    conversation_id: str | None = None
    binary: str | None = None
    preamble: str | None = DEFAULT_PREAMBLE
    turn_timeout: float | None = None
    # None means reject permission requests. The terminal supplies an interactive callback.
    on_permission: Callable[[ToolProgress], bool] | None = field(default=None, repr=False)
    on_force_stop: Callable[[], bool] | None = field(default=None, repr=False)
    _connection: AcpConnection | None = field(default=None, init=False, repr=False)
    _capabilities: dict = field(default_factory=dict, init=False, repr=False)
    _active_session: str | None = field(default=None, init=False, repr=False)
    _config: list[dict] = field(default_factory=list, init=False, repr=False)
    _preamble_pending: bool = field(default=False, init=False, repr=False)

    def __post_init__(self) -> None:
        self.binary = resolve_binary(self.binary)

    def __enter__(self) -> "AgyClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._connection:
            self._connection.close()
            self._connection = None
        self._active_session = None

    def reset(self) -> None:
        self.conversation_id = None
        self._active_session = None
        self._config = []
        self._preamble_pending = False

    @property
    def effective_effort(self) -> str:
        return self.preferences.effort

    @property
    def preferences(self) -> SessionPreferences:
        if self.effort is not None and self.effort not in EFFORT_LEVELS:
            raise ValueError("Thinking level must be low, medium, or high")
        return SessionPreferences.from_record({
            "conversation_id": self.conversation_id, "model": self.model, "effort": self.effort,
        })

    def resume(self, preferences: SessionPreferences, *, model: str | None = None, effort: str | None = None) -> None:
        self.reset()
        self.conversation_id = preferences.conversation_id
        self.model = model if model is not None else preferences.model
        self.effort = effort if effort is not None else preferences.effort

    def _connect(self) -> AcpConnection:
        if self._connection and not self._connection.usable:
            self.close()
        if self._connection is None:
            AGY_WORKSPACE.mkdir(parents=True, exist_ok=True)
            self._connection = AcpConnection(self.binary, AGY_WORKSPACE, ACP_DIAGNOSTIC_LOG)
            self._connection.on_force_stop = self.on_force_stop
            try:
                initialized = self._connection.request("initialize", {
                    "protocolVersion": 1, "clientCapabilities": {},
                    "clientInfo": {"name": "agyspeak", "version": "0.1.0"},
                }, timeout=60)
                if initialized.get("protocolVersion") != 1:
                    raise RuntimeError("Antigravity ACP did not negotiate protocol v1")
                self._capabilities = initialized.get("agentCapabilities", {})
            except BaseException:
                self.close()
                raise
        return self._connection

    def _session(self, connection: AcpConnection, on_event: Callable[[ChatEvent], None] | None = None) -> None:
        if self._active_session == self.conversation_id and self.conversation_id:
            return
        params = {"cwd": str(AGY_WORKSPACE), "mcpServers": []}
        if self.conversation_id:
            capabilities = self._capabilities.get("sessionCapabilities", {})
            if "resume" in capabilities:
                method = "session/resume"
            elif self._capabilities.get("loadSession"):
                method = "session/load"
            else:
                raise RuntimeError("This ACP runtime cannot resume saved conversations")
            params["sessionId"] = self.conversation_id
        else:
            method = "session/new"
        try:
            result = connection.request(method, params, timeout=60)
        except AcpError as exc:
            if exc.code != -32000:  # ACP authentication required; never retry prompts.
                raise
            if on_event:
                on_event(AuthenticationRequired())
            connection.request("authenticate", {"methodId": "oauth-personal"}, timeout=300)
            result = connection.request(method, params, timeout=60)
        if method == "session/new":
            self.conversation_id = result["sessionId"]
            self._preamble_pending = True
        self._active_session = self.conversation_id
        self._config = result.get("configOptions", [])

    def _configure(self, connection: AcpConnection, category: str, value: str) -> None:
        option = next((o for o in self._config if o.get("category") == category or o.get("id") == category), None)
        if option is None:
            raise RuntimeError(f"Antigravity ACP does not expose a {category} selector")
        values = _select_values(option.get("options", []))
        if value not in values:
            raise ValueError(f"ACP {category} {value!r} is unavailable. Available: {', '.join(values)}")
        if option.get("currentValue") != value:
            result = connection.request("session/set_config_option", {
                "sessionId": self.conversation_id, "configId": option["id"], "value": value,
            }, timeout=60)
            if "configOptions" in result:
                self._config = result["configOptions"]
            else:
                option["currentValue"] = value

    def models(self, on_event: Callable[[ChatEvent], None] | None = None) -> list[str]:
        connection = self._connect()
        listing_only = self.conversation_id is None
        try:
            self._session(connection, on_event)
            option = next((o for o in self._config if o.get("category") == "model" or o.get("id") == "model"), {})
            return _select_values(option.get("options", []))
        finally:
            # Do not save a catalog-only session as a conversation: no first
            # prompt (or preamble) has been sent to it.
            if listing_only:
                self.reset()

    def _configure_model(self, connection: AcpConnection) -> None:
        preferences = self.preferences
        self._configure(connection, "model", preferences.model)
        self._configure(connection, "thought_level", preferences.effort)
        self.model = preferences.model
        self.effort = preferences.effort

    @staticmethod
    def build_prompt(text: str, audio: Path | None) -> str:
        text = text.strip()
        if audio is None:
            return text
        if not text:
            text = DEFAULT_VOICE_PROMPT
        # Fallback for runtimes without native audio prompt capability.
        path = json.dumps(str(audio.resolve()), ensure_ascii=False)
        return (
            f"{text}\n\n"
            f"Audio recording: {path}\n"
            "For this recording, use the native file-viewing tool (view_file, or "
            "read_file in some toolsets) to open the file and listen to the "
            "returned native audio. This is an audio file, not text. Do not use "
            "shell commands, scripts, external transcription tools, or inspect "
            "the workspace. If the viewer cannot return audio, say so instead "
            "of guessing what was said."
        )

    def send(
        self,
        text: str,
        audio: Path | None = None,
        on_event: Callable[[ChatEvent], None] | None = None,
    ) -> Turn:
        from agyspeak.audio import prepare_for_model

        reference = text.strip()
        if audio is None and reference.startswith("@") and "\n" not in reference:
            candidate = Path(reference[1:].strip("\"'")).expanduser()
            if candidate.suffix.lower() in {".wav", ".mp3", ".m4a", ".ogg", ".flac"} and candidate.is_file():
                audio, text = candidate, ""
        parts = prepare_for_model(audio) if audio is not None and audio.is_file() else [audio]
        if len(parts) == 1:
            return self._send_once(text, parts[0], on_event)

        started = time.monotonic()
        request = text.strip() or DEFAULT_VOICE_PROMPT
        for index, part in enumerate(parts, 1):
            if on_event:
                on_event(AudioPart(index, len(parts), part))
            if index < len(parts):
                acknowledgment = f"Received part {index}/{len(parts)}."
                prompt = (
                    f"This is part {index}/{len(parts)} of one recording, in chronological order. "
                    f"The user's request for the full recording is: {request}\n"
                    "Listen and retain the content for the following parts. Do not answer yet; "
                    f"reply only with exactly: {acknowledgment}"
                )
            else:
                prompt = (
                    f"This is the final part {index}/{len(parts)} of the recording. "
                    "Listen, then answer the user's request using all parts in order:\n" + request
                )
            callback = on_event
            if index < len(parts) and on_event:
                # Multipart acknowledgements are internal, not narration text.
                def callback(event: ChatEvent) -> None:
                    if not isinstance(event, TextDelta):
                        on_event(event)
            turn = self._send_once(prompt, part, callback)
            if index < len(parts) and turn.response.strip() != acknowledgment:
                turn.notes.append(f"Stopped at audio part {index}/{len(parts)}: no acknowledgment received.")
                break
        turn.duration = time.monotonic() - started
        return turn

    def _send_once(
        self,
        text: str,
        audio: Path | None = None,
        on_event: Callable[[ChatEvent], None] | None = None,
    ) -> Turn:
        TURN_LOG_DIR.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", buffering=1,
            prefix=datetime.now().strftime("%Y%m%d-%H%M%S-"), suffix=".log",
            dir=TURN_LOG_DIR, delete=False,
        ) as raw_log:
            turn = Turn(log_path=Path(raw_log.name))
            connection = self._connect()
            connection.log = raw_log
            # Session loading may replay old messages; only collect the new prompt below.
            connection.on_notification = lambda method, params: None
            tool_calls: dict[str, dict] = {}

            def notification(method: str, params: dict) -> None:
                if method != "session/update" or params.get("sessionId") != self.conversation_id:
                    return
                update = params.get("update", {})
                kind = update.get("sessionUpdate")
                if kind == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        delta = content.get("text", "")
                        turn.response += delta
                        if on_event:
                            on_event(TextDelta(delta))
                elif kind in {"tool_call", "tool_call_update"}:
                    call_id = update.get("toolCallId", "")
                    call = tool_calls.setdefault(call_id, {})
                    call.update(update)
                    raw_input = call.get("rawInput") or {}
                    if not isinstance(raw_input, dict):
                        raw_input = {"input": raw_input}
                    if on_event:
                        on_event(ToolProgress(call_id, call.get("title", "tool"), raw_input))
                elif kind == "usage_update":
                    turn.usage = {"total_tokens": update.get("used", 0), **update}
                elif kind == "config_option_update":
                    self._config = update.get("configOptions", self._config)

            def request(method: str, params: dict) -> dict:
                if method != "session/request_permission":
                    raise AcpError({"code": -32601, "message": "Client method not supported"})
                call = params.get("toolCall", {})
                call = {**tool_calls.get(call.get("toolCallId"), {}), **call}
                arguments = call.get("rawInput") or {}
                if not isinstance(arguments, dict):
                    arguments = {"input": arguments}
                tool = ToolProgress(call.get("toolCallId", ""), call.get("title", "tool"), arguments)
                allow = params.get("sessionId") == self.conversation_id and (
                    self.yolo or bool(self.on_permission and self.on_permission(tool))
                )
                kind = "allow_once" if allow else "reject_once"
                option = next((o for o in params.get("options", []) if o.get("kind") == kind), None)
                if not option:
                    allow = False
                if not allow:
                    turn.denied_actions.append({"action": call.get("title", "tool"), **call})
                outcome = {"outcome": "selected", "optionId": option["optionId"]} if option else {"outcome": "cancelled"}
                return {"outcome": outcome}

            connection.on_request = request
            try:
                self._session(connection, on_event)
                turn.conversation_id = self.conversation_id
                self._configure_model(connection)
                self._configure(connection, "mode", "yolo" if self.yolo else "default")
                native_audio = audio is not None and self._capabilities.get("promptCapabilities", {}).get("audio", False)
                prompt = (text.strip() or DEFAULT_VOICE_PROMPT) if native_audio else self.build_prompt(text, audio)
                if self.preamble and self._preamble_pending:
                    prompt = f"{self.preamble}\n\n{prompt}"
                blocks = [{"type": "text", "text": prompt}]
                if native_audio:
                    mime = {
                        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
                        ".ogg": "audio/ogg", ".flac": "audio/flac",
                    }.get(audio.suffix.lower(), "application/octet-stream")
                    blocks.append({
                        "type": "audio", "mimeType": mime,
                        "data": base64.b64encode(audio.read_bytes()).decode("ascii"),
                    })
                connection.on_notification = notification
                result = connection.request("session/prompt", {
                    "sessionId": self.conversation_id, "prompt": blocks,
                }, timeout=self.turn_timeout)
                self._preamble_pending = False
                turn.status = result.get("stopReason", "")
            finally:
                connection.log = None
                connection.on_notification = lambda method, params: None
                connection.on_request = None
        turn.duration = time.monotonic() - started
        return turn
