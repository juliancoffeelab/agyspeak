"""Interactive terminal chat: type or record, talk to Gemini through `agy`."""

from __future__ import annotations

import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path

import typer
from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text

from agyspeak import audio as audio_mod
from agyspeak.backend import DEFAULT_MODEL, AgyClient, AgyNotFound, Turn
from agyspeak.terminal_math import for_terminal

app = typer.Typer(add_completion=False, rich_markup_mode="rich")
console = Console()

STATE_DIR = Path.home() / ".cache" / "agyspeak"
LAST_SESSION = STATE_DIR / "last_session.json"
SESSIONS = STATE_DIR / "sessions.jsonl"
HISTORY = STATE_DIR / "history"

HELP = r"""
[bold]Commands[/bold]
  /a \[note]         record from the mic; Enter stops and sends immediately
  /rec, /r \[note]   record, then ask for a note before sending
  Enter             start recording when the prompt is empty
  /last \[note]      re-send the most recent recording
  /model \[name]     show or switch the model (see /models)
  /models           list models available through agy
  /new              start a fresh conversation
  /id               print the current conversation id
  /sessions         list saved sessions (resume with `agyspeak --conversation <id>`)
  /devices          list input devices
  /help             this text
  /quit, /q         exit (ctrl+d also works)

Anything else is sent as a text message."""


def _save_session(client: AgyClient) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAST_SESSION.write_text(
        json.dumps({"conversation_id": client.conversation_id, "model": client.model})
    )


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
    console.print(f"[dim]saved {secs:.1f}s → {path}[/dim]")
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
    body = for_terminal(turn.response.strip())
    if not body:
        console.print("[red]empty response[/red]" + (f" (status {turn.status})" if turn.status else ""))
        return
    usage = turn.usage or {}
    subtitle = f"{model} · {turn.duration:.0f}s"
    if usage.get("total_tokens"):
        subtitle += f" · {usage['total_tokens']} tok"
    console.print(Panel(Markdown(body), title="gemini", subtitle=subtitle, border_style="blue"))


def _send(client: AgyClient, text: str, clip: Path | None) -> None:
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
    _save_session(client)
    if is_first:
        _log_session(client, text or "(voice message)")


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

    model_given = "--model" in sys.argv or "-m" in sys.argv
    if conversation:
        client.conversation_id = _resolve_conversation(conversation)
        entry = next((e for e in _load_sessions() if e["id"] == client.conversation_id), None)
        if entry and not model_given:
            client.model = entry["model"]
    elif resume:
        last = _load_session()
        if last.get("conversation_id"):
            client.conversation_id = last["conversation_id"]
            if not model_given and last.get("model"):
                client.model = last["model"]
        else:
            console.print("[yellow]no previous session to continue[/yellow]")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    bindings = KeyBindings()

    bindings.add("enter")(_submit_or_record)

    session: PromptSession[str] = PromptSession(
        history=FileHistory(str(HISTORY)),
        key_bindings=bindings,
        prompt_continuation=lambda width, _line, _wrap: " " * width,
    )

    console.print(
        Panel(
            f"model [bold]{client.model}[/bold]"
            + (f" · resuming [dim]{client.conversation_id}[/dim]" if client.conversation_id else "")
            + "\n[dim]Enter to talk · /help for commands[/dim]",
            title="agyspeak",
            border_style="green",
        )
    )

    last_clip: Path | None = None
    while True:
        try:
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
                _send(client, note, clip)
            case "/last":
                if last_clip is None:
                    latest = audio_mod.RECORDINGS_DIR / "latest.wav"
                    last_clip = latest.resolve() if latest.exists() else None
                if last_clip is None:
                    console.print("[yellow]no recording yet[/yellow]")
                    continue
                _send(client, rest, last_clip)
            case "/model":
                if rest:
                    client.model = rest
                console.print(f"model: [bold]{client.model}[/bold]")
            case "/models":
                _run_agy("models")
            case "/new":
                client.reset()
                console.print("[dim]new conversation[/dim]")
            case "/id":
                console.print(client.conversation_id or "[dim]none yet[/dim]")
            case "/sessions":
                _print_sessions()
            case "/devices":
                for idx, name in audio_mod.list_input_devices():
                    marker = "*" if idx == device else " "
                    console.print(f" {marker} {idx}: {name}")
            case _ if cmd.startswith("/"):
                console.print(f"[yellow]unknown command {cmd}[/yellow] (try /help)")
            case _:
                _send(client, line, None)

    if client.conversation_id:
        _log_session(client)
        console.print(
            f"[dim]session saved as [bold]{client.conversation_id[:8]}[/bold]. "
            f"Resume with[/dim] agyspeak -c [dim]or[/dim] "
            f"agyspeak --conversation {client.conversation_id[:8]}"
        )


if __name__ == "__main__":
    app()
