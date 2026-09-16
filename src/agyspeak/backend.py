"""Thin wrapper around `agy --print` with stream-json output."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "gemini-3.7-flash-high"
DEFAULT_VOICE_PROMPT = "Listen to this voice message and respond to it."
DEFAULT_PREAMBLE = """\
You are a general multimodal assistant talking with the user in a terminal chat. \
This is not a coding session. The user may type or send voice recordings, and you \
receive that audio directly as input, so listen to it rather than opening the file \
with tools. A common use is language learning: transcribe or answer what was said, \
and when asked comment on pronunciation, accent, grammar, or word choice, with the \
level of detail the user asks for. Otherwise behave as a helpful conversational \
assistant on any topic. Do not use file or shell tools unless the user asks for \
something that needs them. If a `speak` tool is available, use it only when the \
user asks to hear something aloud. Output is rendered in a terminal Markdown \
viewer with no LaTeX support, so write formulas as plain text or Unicode instead \
of using LaTeX math delimiters or commands."""

Event = dict


@dataclass
class Turn:
    response: str = ""
    conversation_id: str | None = None
    status: str = ""
    usage: dict = field(default_factory=dict)
    denied_actions: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    duration: float = 0.0


class AgyNotFound(RuntimeError):
    pass


@dataclass
class AgyClient:
    model: str = DEFAULT_MODEL
    effort: str | None = None
    yolo: bool = False
    conversation_id: str | None = None
    timeout: str = "5m"
    binary: str = "agy"
    preamble: str | None = DEFAULT_PREAMBLE

    def __post_init__(self) -> None:
        if shutil.which(self.binary) is None:
            raise AgyNotFound(f"`{self.binary}` not found on PATH; install the Antigravity CLI")

    def reset(self) -> None:
        self.conversation_id = None

    def _argv(self, prompt: str) -> list[str]:
        argv = [
            self.binary,
            "--model",
            self.model,
            "--output-format",
            "stream-json",
            "--print-timeout",
            self.timeout,
            "--disable-slash-commands",
        ]
        if self.effort:
            argv += ["--effort", self.effort]
        if self.yolo:
            argv.append("--dangerously-skip-permissions")
        if self.conversation_id:
            argv += ["--conversation", self.conversation_id]
        argv += ["-p", prompt]
        return argv

    @staticmethod
    def build_prompt(text: str, audio: Path | None) -> str:
        text = text.strip()
        if audio is None:
            return text
        if not text:
            text = DEFAULT_VOICE_PROMPT
        # `agy` attaches files referenced as @/absolute/path (must live under $HOME).
        return f"{text} @{audio.resolve()}"

    def send(
        self,
        text: str,
        audio: Path | None = None,
        on_event: Callable[[Event], None] | None = None,
    ) -> Turn:
        prompt = self.build_prompt(text, audio)
        if self.preamble and not self.conversation_id:
            prompt = f"{self.preamble}\n\n{prompt}"
        proc = subprocess.Popen(
            self._argv(prompt),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        turn = Turn()
        started = time.monotonic()
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                turn.notes.append(line)
                continue
            if on_event:
                on_event(event)
            if event.get("event") == "result":
                result = event.get("result", {})
                turn.response = result.get("response", "")
                turn.conversation_id = result.get("conversation_id")
                turn.status = result.get("status", "")
                turn.usage = result.get("usage", {})
                turn.denied_actions = result.get("denied_actions", [])
            elif event.get("event") == "init":
                turn.conversation_id = event.get("conversation_id") or turn.conversation_id
        code = proc.wait()
        # agy's own duration_seconds is cumulative for the conversation, so time it here.
        turn.duration = time.monotonic() - started
        if code != 0 and not turn.response:
            turn.notes.append(f"agy exited with code {code}")
        if turn.conversation_id:
            if self.conversation_id and turn.conversation_id != self.conversation_id:
                turn.notes.append(
                    f"agy did not resume {self.conversation_id[:8]}; it started a new "
                    f"conversation {turn.conversation_id[:8]} (context is empty)"
                )
            self.conversation_id = turn.conversation_id
        return turn
