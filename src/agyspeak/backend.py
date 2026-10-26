"""Thin wrapper around `agy --print` with stream-json output."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

TURN_LOG_DIR = Path.home() / ".cache" / "agyspeak" / "turns"

DEFAULT_MODEL = "gemini-3.8-flash-medium"
DEFAULT_VOICE_PROMPT = "Listen to this voice message and respond to it."
DENIAL_RECOVERY_PROMPT = (
    "The tool request was denied. The denial stands: do not retry it or access "
    "the same resource through another tool. Respond to my preceding request "
    "now using the conversation and any audio already available. Do not call "
    "any more tools or inspect conversation logs. If you lack information "
    "needed to answer, explain what is missing instead of guessing. "
    "Return only the answer addressed to me, without planning or thinking text."
)
# agy has an unavoidable five-minute default and treats zero/negative values as
# immediate expiry. This is Go's largest whole-second duration (~292 years).
UNBOUNDED_PRINT_TIMEOUT = "2562047h47m16s"
DEFAULT_PREAMBLE = """\
You are a general multimodal assistant talking with the user in a terminal chat. \
This is not a coding session. The user may type or send voice recordings, and you \
receive a path to each recording. Open it with the native file-viewing tool \
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

Event = dict


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


@dataclass
class AgyClient:
    model: str = DEFAULT_MODEL
    effort: str | None = None
    yolo: bool = False
    conversation_id: str | None = None
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
            UNBOUNDED_PRINT_TIMEOUT,
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
        # Print mode sends @paths as text. The native file viewer returns the WAV
        # as model-visible audio; repeat this instruction for resumed chats too.
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
        on_event: Callable[[Event], None] | None = None,
    ) -> Turn:
        turn = self._send_once(text, audio, on_event)
        if turn.response.strip() or not turn.denied_actions or not self.conversation_id:
            return turn
        # Print mode exits on some permission denials. Continue once without
        # replaying the recording or granting the denied operation.
        recovery = self._send_once(DENIAL_RECOVERY_PROMPT, on_event=on_event)
        recovery.duration += turn.duration
        recovery.notes = turn.notes + [
            "Tool request denied; continued once to request an answer without tools."
        ] + recovery.notes
        recovery.denied_actions = turn.denied_actions + recovery.denied_actions
        return recovery

    def _send_once(
        self,
        text: str,
        audio: Path | None = None,
        on_event: Callable[[Event], None] | None = None,
    ) -> Turn:
        prompt = self.build_prompt(text, audio)
        if self.preamble and not self.conversation_id:
            prompt = f"{self.preamble}\n\n{prompt}"
        TURN_LOG_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", buffering=1,
            prefix=datetime.now().strftime("%Y%m%d-%H%M%S-"), suffix=".log",
            dir=TURN_LOG_DIR, delete=False,
        ) as raw_log:
            proc = subprocess.Popen(
                self._argv(prompt),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            turn = Turn(log_path=Path(raw_log.name))
            started = time.monotonic()
            assert proc.stdout is not None
            for line in proc.stdout:
                raw_log.write(line)
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
