"""Interactive terminal chat: type or record, talk to Gemini through `agy`."""

from __future__ import annotations

import atexit
import json
import os
import select
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import typer
from prompt_toolkit import PromptSession
from prompt_toolkit.application import run_in_terminal
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.patch_stdout import patch_stdout
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from agyspeak import audio as audio_mod
from agyspeak import player, tts, worker
from agyspeak.backend import DEFAULT_MODEL, AgyClient, AgyNotFound, Turn
from agyspeak.speech_text import narration_chunks
from agyspeak.terminal_math import TerminalMarkdown

app = typer.Typer(add_completion=False, rich_markup_mode="rich")
console = Console()

STATE_DIR = Path.home() / ".cache" / "agyspeak"
LAST_SESSION = STATE_DIR / "last_session.json"
SESSIONS = STATE_DIR / "sessions.jsonl"
HISTORY = STATE_DIR / "history"
VOICE_MODE_SPEED = 1.08

HELP = r"""
[bold]Commands[/bold]
  /a \[note]         record from the mic; Enter stops and sends immediately
  /rec, /r \[note]   record, then ask for a note before sending
  Enter             start recording when the prompt is empty
  /last \[note]      re-send the most recent recording
  /repeat           narrate the last model reply again
  /model \[name]     show or switch the model (see /models)
  /models           list models available through agy
  /new              start a fresh conversation
  /id               print the current conversation id
  /sessions         list saved sessions (resume with `agyspeak --conversation <id>`)
  /devices          list input devices
  /voice [name]     show or select the Kokoro voice
  /voices           list available Kokoro voices
  /speech status    show loaded models and queued work
  /speech load [kokoro [voice]|qwen]
  /speech unload [kokoro|qwen|all]
  /speech stop      stop current and queued speech
  Tab               toggle automatic voice replies
  /help             this text
  /quit, /q         exit (ctrl+d also works)

Anything else is sent as a text message."""


@dataclass
class VoiceMode:
    voice: str = tts.DEFAULT_KOKORO_VOICE
    enabled: bool = False
    on_change: Callable[[], None] | None = field(default=None, repr=False)

    def _changed(self) -> None:
        if self.on_change:
            self.on_change()

    def toggle(self) -> str:
        if self.enabled:
            player.unload()
            self.enabled = False
            self._changed()
            return "[dim]voice mode off · speech model unloaded[/dim]"
        try:
            worker.warm(self.voice)
        except Exception as exc:
            return f"[red]could not start voice mode:[/red] {exc}"
        self.enabled = True
        self._changed()
        return f"[green]voice mode on[/green] · Kokoro [bold]{self.voice}[/bold]"

    def select(self, voice: str) -> str:
        if voice not in tts.kokoro_voices():
            return f"[red]unknown Kokoro voice {voice!r}[/red] (try /voices)"
        try:
            if self.enabled:
                worker.warm(voice)
        except Exception as exc:
            return f"[red]could not load {voice!r}:[/red] {exc}"
        self.voice = voice
        self._changed()
        return f"voice: [bold]{voice}[/bold]"

    def narrate(self, markdown: str) -> str | None:
        if not self.enabled:
            return None
        lines = [
            {
                "text": chunk.text,
                "voice": self.voice,
                "speed": VOICE_MODE_SPEED,
                "pause_before": chunk.pause_before,
            }
            for chunk in narration_chunks(markdown)
        ]
        if not lines:
            return None
        try:
            player.start(lines, pause=0.0)
        except Exception as exc:
            return f"[yellow]could not narrate reply:[/yellow] {exc}"
        return None


def _speech_command(arguments: str, voice: str) -> str:
    """Run one harness speech-control command and return Rich-formatted output."""
    parts = arguments.split()
    action = parts[0] if parts else "status"
    try:
        if action == "status":
            state = worker.status()
            loaded = state["loaded"]
            kokoro = ", ".join(loaded["kokoro"]) or "none"
            qwen = ", ".join(loaded["qwen"]) or "none"
            activity = state["active"] or "idle"
            result = (
                f"speech: [bold]{activity}[/bold] · queued {state['queued']} · "
                f"kokoro {kokoro} · qwen {qwen}"
            )
            if state.get("last_error"):
                result += f"\n[red]last error:[/red] {state['last_error']}"
            return result
        if action == "stop" and len(parts) == 1:
            return "[dim]speech stopped[/dim]" if player.stop() else "[dim]nothing was playing[/dim]"
        if action == "load" and len(parts) <= 3:
            engine = parts[1] if len(parts) >= 2 else "kokoro"
            if engine not in {"kokoro", "qwen"}:
                raise ValueError(f"unknown speech engine {engine!r}")
            selected_voice = parts[2] if len(parts) == 3 else voice
            worker.load(engine, selected_voice)
            return f"[dim]loading {engine} in the background[/dim]"
        if action == "unload" and len(parts) <= 2:
            engine = parts[1] if len(parts) == 2 else "all"
            if engine not in {"kokoro", "qwen", "all"}:
                raise ValueError(f"unknown speech engine {engine!r}")
            player.unload(engine)
            return f"[dim]unloading {engine} in the background[/dim]"
    except Exception as exc:
        return f"[red]speech command failed:[/red] {exc}"
    return "[yellow]usage:[/yellow] /speech status|stop|load [kokoro [voice]|qwen]|unload [kokoro|qwen|all]"


def _save_session(
    client: AgyClient,
    voice_mode: VoiceMode | None = None,
    last_response: str | None = None,
) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state = _load_session()
    state["model"] = client.model
    if client.conversation_id:
        state["conversation_id"] = client.conversation_id
    if voice_mode:
        state["voice"] = voice_mode.voice
        state["voice_mode"] = voice_mode.enabled
    if last_response is not None:
        state["last_response"] = last_response
    LAST_SESSION.write_text(json.dumps(state))


def _load_sessions() -> list[dict]:
    """Read the append-only registry and merge lines by id (later lines win)."""
    try:
        lines = SESSIONS.read_text().splitlines()
    except OSError:
        return []
    merged: dict[str, dict] = {}
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("id") in merged:
            merged[entry["id"]].update({k: v for k, v in entry.items() if v})
        else:
            merged[entry["id"]] = entry
    return sorted(merged.values(), key=lambda e: e.get("updated", ""))


def _log_session(client: AgyClient, title: str = "") -> None:
    """Append one line to the registry; a title is only given for new sessions."""
    if not client.conversation_id:
        return
    now = time.strftime("%Y-%m-%d %H:%M")
    entry = {"id": client.conversation_id, "model": client.model, "updated": now}
    if title:
        entry["started"] = now
        entry["title"] = title[:60]
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with SESSIONS.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")


def _print_sessions() -> None:
    sessions = _load_sessions()
    if not sessions:
        console.print("[dim]no saved sessions[/dim]")
        return
    for entry in reversed(sessions[-20:]):
        console.print(
            f"[bold]{entry['id'][:8]}[/bold]  {entry['updated']}  "
            f"[dim]{entry['model']}[/dim]  {entry.get('title', '')}"
        )


def _resolve_conversation(prefix: str) -> str:
    """Expand an id prefix (as shown by /sessions) to a full conversation id."""
    matches = [e["id"] for e in _load_sessions() if e["id"].startswith(prefix)]
    if len(matches) == 1:
        return matches[0]
    # agy silently starts a fresh conversation for an unknown id, so refuse.
    if not matches:
        console.print(f"[red]no saved session starts with {prefix!r}[/red]")
    else:
        console.print(f"[red]ambiguous prefix {prefix!r}, matches {len(matches)} sessions[/red]")
    _print_sessions()
    raise typer.Exit(1)


def _load_session() -> dict:
    try:
        return json.loads(LAST_SESSION.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _display_path(path: Path) -> str:
    """Shorten paths under the user's home directory for terminal output."""
    try:
        return str(Path("~") / path.relative_to(Path.home()))
    except ValueError:
        return str(path)


def _recording_input(fd: int, timeout: float = 0.05) -> str | None:
    """Return stop/cancel for terminal input without assuming cooked line mode."""
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return None
    data = os.read(fd, 1024)
    if not data or b"\x03" in data:
        return "cancel"
    if b"\r" in data or b"\n" in data:
        return "stop"
    return None


def _record(device: int | None) -> Path | None:
    """Record until Enter is pressed. Returns the saved path, or None if cancelled/empty."""
    rec = audio_mod.Recorder(device=device)
    try:
        rec.start()
    except Exception as exc:  # sounddevice raises a few different types
        console.print(f"[red]Could not open microphone:[/red] {exc}")
        return None

    cancelled = False
    input_fd = sys.stdin.fileno()
    try:
        with Live(console=console, refresh_per_second=15, transient=True) as live:
            while True:
                bar = audio_mod.level_bar(rec.rms)
                live.update(
                    Text.assemble(
                        ("● REC ", "bold red"),
                        (f"{rec.elapsed:5.1f}s  ", "bold"),
                        (bar, "green"),
                        ("   Enter to stop, ctrl+c to cancel", "dim"),
                    )
                )
                action = _recording_input(input_fd)
                if action == "stop":
                    break
                if action == "cancel":
                    cancelled = True
                    break
    except KeyboardInterrupt:
        cancelled = True
    samples = rec.stop()
    if cancelled:
        console.print("[dim]recording cancelled[/dim]")
        return None
    if len(samples) < rec.sample_rate // 10:
        console.print("[yellow]recording too short, discarded[/yellow]")
        return None
    path = rec.save(samples)
    secs = len(samples) / rec.sample_rate
    console.print(f"[dim]saved {secs:.1f}s → {_display_path(path)}[/dim]")
    return path


def _render_turn(turn: Turn, model: str) -> None:
    for note in turn.notes:
        console.print(f"[dim]{note}[/dim]")
    if turn.denied_actions:
        names = ", ".join(a.get("display_name", a.get("action", "?")) for a in turn.denied_actions)
        console.print(
            f"[yellow]agy auto-denied tool use ({names}). "
            "Start with --yolo to let it run tools.[/yellow]"
        )
    body = turn.response.strip()
    if not body:
        console.print("[red]empty response[/red]" + (f" (status {turn.status})" if turn.status else ""))
        return
    usage = turn.usage or {}
    subtitle = f"{model} · {turn.duration:.0f}s"
    if usage.get("total_tokens"):
        subtitle += f" · {usage['total_tokens']} tok"
    console.print(
        Panel(TerminalMarkdown(body), title="gemini", subtitle=subtitle, border_style="blue")
    )


def _send(client: AgyClient, text: str, clip: Path | None, voice_mode: VoiceMode) -> str:
    label = "voice" if clip else "text"
    is_first = client.conversation_id is None
    with console.status(f"[bold blue]thinking[/bold blue] [dim]({label})[/dim]") as status:

        def on_event(event: dict) -> None:
            if event.get("event") != "step_update":
                return
            step = event.get("step_update", {})
            if step.get("step_type") == "tool":
                status.update(f"[bold blue]tool[/bold blue] [dim]{step.get('tool_name')}[/dim]")
            elif step.get("step_type") == "agent_response":
                status.update("[bold blue]responding[/bold blue]")

        turn = client.send(text, clip, on_event=on_event)
    _render_turn(turn, client.model)
    if speech_error := voice_mode.narrate(turn.response):
        console.print(speech_error)
    _save_session(client, voice_mode, turn.response)
    if is_first:
        _log_session(client, text or "(voice message)")
    return turn.response


def _repeat_last(last_response: str, voice_mode: VoiceMode) -> str:
    if not last_response.strip():
        return "[yellow]no model reply yet[/yellow]"
    if not voice_mode.enabled:
        return "[yellow]voice mode is off[/yellow] (press Tab to enable it)"
    if error := voice_mode.narrate(last_response):
        return error
    return "[dim]replaying last model reply[/dim]"


def _run_agy(*args: str) -> None:
    subprocess.run(["agy", *args], check=False)


def _submit_or_record(event) -> None:  # noqa: ANN001
    """Submit typed input, or turn an empty prompt into the audio command."""
    buffer = event.app.current_buffer
    if not buffer.text.strip():
        buffer.text = "/a"
    buffer.validate_and_handle()


@app.command()
def main(
    model: str = typer.Option(DEFAULT_MODEL, "--model", "-m", help="agy model id (see `agy models`)"),
    effort: str | None = typer.Option(None, "--effort", help="low | medium | high"),
    resume: bool = typer.Option(False, "--continue", "-c", help="resume the last conversation"),
    conversation: str | None = typer.Option(None, "--conversation", help="resume a conversation by id"),
    yolo: bool = typer.Option(False, "--yolo", help="pass --dangerously-skip-permissions to agy"),
    device: int | None = typer.Option(None, "--device", "-d", help="input device index (see /devices)"),
    list_sessions: bool = typer.Option(False, "--list", "-l", help="list saved sessions and exit"),
    system: str | None = typer.Option(None, "--system", help="replace the preamble sent on a new conversation"),
    no_system: bool = typer.Option(False, "--no-system", help="send no preamble at all"),
    voice: str = typer.Option(tts.DEFAULT_KOKORO_VOICE, "--voice", help="Kokoro voice for voice mode"),
) -> None:
    """Voice + text chat with Gemini via the Antigravity CLI."""
    if list_sessions:
        _print_sessions()
        raise typer.Exit()
    try:
        client = AgyClient(model=model, effort=effort, yolo=yolo)
        if no_system:
            client.preamble = None
        elif system:
            client.preamble = system
    except AgyNotFound as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    speech_service = worker.HarnessSpeechService()
    try:
        speech_service.start()
    except Exception as exc:
        console.print(f"[red]could not start speech service:[/red] {exc}")
        raise typer.Exit(1)
    atexit.register(speech_service.close)

    last = _load_session()
    last_response = str(last.get("last_response") or "")
    model_given = "--model" in sys.argv or "-m" in sys.argv
    voice_given = any(arg == "--voice" or arg.startswith("--voice=") for arg in sys.argv[1:])
    if conversation:
        client.conversation_id = _resolve_conversation(conversation)
        entry = next((e for e in _load_sessions() if e["id"] == client.conversation_id), None)
        if entry and not model_given:
            client.model = entry["model"]
    elif resume:
        if last.get("conversation_id"):
            client.conversation_id = last["conversation_id"]
            if not model_given and last.get("model"):
                client.model = last["model"]
        else:
            console.print("[yellow]no previous session to continue[/yellow]")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    saved_voice = str(last.get("voice") or voice)
    voice_mode = VoiceMode(voice=voice if voice_given else saved_voice)
    voice_mode.on_change = lambda: _save_session(client, voice_mode)
    restored_voice_message = ""
    if last.get("voice_mode"):
        restored_voice_message = voice_mode.toggle()
    elif voice_given:
        _save_session(client, voice_mode)
    bindings = KeyBindings()

    bindings.add("enter")(_submit_or_record)

    @bindings.add("tab")
    def _toggle_voice(_event) -> None:  # noqa: ANN001
        run_in_terminal(lambda: console.print(voice_mode.toggle()))

    session: PromptSession[str] = PromptSession(
        history=FileHistory(str(HISTORY)),
        key_bindings=bindings,
        prompt_continuation=lambda width, _line, _wrap: " " * width,
    )

    console.print(
        Panel(
            f"model [bold]{client.model}[/bold]"
            + (f" · resuming [dim]{client.conversation_id}[/dim]" if client.conversation_id else "")
            + f"\n[dim]Enter to talk · voice {('on' if voice_mode.enabled else 'off')} "
            f"({voice_mode.voice}) · Tab toggles · /help for commands[/dim]",
            title="agyspeak",
            border_style="green",
        )
    )
    if restored_voice_message and not voice_mode.enabled:
        console.print(restored_voice_message)

    last_clip: Path | None = None
    while True:
        try:
            # Keep diagnostics from background model loading above the active
            # prompt instead of letting them overwrite terminal UI state.
            with patch_stdout(raw=True):
                line = session.prompt("› ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("[dim]bye[/dim]")
            break
        if not line:
            continue

        cmd, _, rest = line.partition(" ")
        rest = rest.strip()
        match cmd:
            case "/quit" | "/q" | "/exit":
                break
            case "/help" | "/?":
                console.print(HELP.strip())
            case "/a" | "/rec" | "/r":
                clip = _record(device)
                if clip is None:
                    continue
                last_clip = clip
                note = rest
                if not note and cmd != "/a":
                    try:
                        note = session.prompt("🎤 note (Enter to send as is) › ").strip()
                    except (EOFError, KeyboardInterrupt):
                        console.print("[dim]not sent[/dim]")
                        continue
                last_response = _send(client, note, clip, voice_mode)
            case "/last":
                if last_clip is None:
                    latest = audio_mod.RECORDINGS_DIR / "latest.wav"
                    last_clip = latest.resolve() if latest.exists() else None
                if last_clip is None:
                    console.print("[yellow]no recording yet[/yellow]")
                    continue
                last_response = _send(client, rest, last_clip, voice_mode)
            case "/repeat":
                console.print(_repeat_last(last_response, voice_mode))
            case "/model":
                if rest:
                    client.model = rest
                console.print(f"model: [bold]{client.model}[/bold]")
            case "/models":
                _run_agy("models")
            case "/new":
                client.reset()
                last_response = ""
                _save_session(client, voice_mode, last_response)
                console.print("[dim]new conversation[/dim]")
            case "/id":
                console.print(client.conversation_id or "[dim]none yet[/dim]")
            case "/sessions":
                _print_sessions()
            case "/devices":
                for idx, name in audio_mod.list_input_devices():
                    marker = "*" if idx == device else " "
                    console.print(f" {marker} {idx}: {name}")
            case "/voice":
                if rest:
                    console.print(voice_mode.select(rest))
                else:
                    state = "on" if voice_mode.enabled else "off"
                    console.print(f"voice: [bold]{voice_mode.voice}[/bold] · mode {state}")
            case "/voices":
                console.print("  ".join(tts.kokoro_voices()))
            case "/speech":
                console.print(_speech_command(rest, voice_mode.voice))
            case _ if cmd.startswith("/"):
                console.print(f"[yellow]unknown command {cmd}[/yellow] (try /help)")
            case _:
                last_response = _send(client, line, None, voice_mode)

    speech_service.close()
    atexit.unregister(speech_service.close)
    if client.conversation_id:
        _log_session(client)
        console.print(
            f"[dim]session saved as [bold]{client.conversation_id[:8]}[/bold]. "
            f"Resume with[/dim] agyspeak -c [dim]or[/dim] "
            f"agyspeak --conversation {client.conversation_id[:8]}"
        )


if __name__ == "__main__":
    app()
