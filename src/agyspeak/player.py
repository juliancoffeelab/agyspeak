"""Detached playback helper.

`agy` kills MCP tool calls after 3 minutes, and a long narration can take far
longer to render and play. So the MCP server never plays audio itself: it
writes the script to a JSON file and launches this module in its own session.
Only one player runs at a time; starting a new one stops the previous one.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import wave
from datetime import datetime
from pathlib import Path

from agyspeak import tts

PID_FILE = tts.SPEECH_DIR / "player.pid"
WORDS_PER_SECOND = 2.6  # rough Kokoro pace at speed 1.0, for the estimate we return


def stop() -> bool:
    """Stop the current player, if any. Returns whether something was running."""
    try:
        pid = int(PID_FILE.read_text())
    except (OSError, ValueError):
        return False
    try:
        os.killpg(pid, signal.SIGTERM)  # the player and its children (afplay)
    except ProcessLookupError:
        PID_FILE.unlink(missing_ok=True)
        return False
    except PermissionError:
        return False
    PID_FILE.unlink(missing_ok=True)
    return True


def start(lines: list[dict], pause: float = 0.4) -> tuple[Path, float]:
    """Launch a detached player for the script; return (script path, estimated seconds)."""
    stop()
    tts.SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    created = datetime.now()
    request_id = created.strftime("%Y%m%d-%H%M%S-%f")
    script = tts.SPEECH_DIR / f"speech_{request_id}.json"
    audio = script.with_suffix(".wav")
    words = sum(len(str(line.get("text", "")).split()) for line in lines)
    estimate = words / WORDS_PER_SECOND + pause * max(len(lines) - 1, 0)
    script.write_text(
        json.dumps(
            {
                "id": request_id,
                "created_at": created.astimezone().isoformat(),
                "status": "queued",
                "audio_file": audio.name,
                "estimated_seconds": estimate,
                "lines": lines,
                "pause": pause,
            },
            indent=2,
        )
        + "\n"
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "agyspeak.player", str(script)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=(tts.SPEECH_DIR / "player.log").open("ab"),
        start_new_session=True,  # survives the MCP server being killed by agy
    )
    PID_FILE.write_text(str(proc.pid))
    return script, estimate


def play_lines(lines: list[dict], pause: float = 0.4, output_path: Path | None = None) -> Path:
    """Stream Kokoro scripts; buffer scripts containing Qwen before playback."""
    if any(tts.line_engine(line) == "qwen" for line in lines):
        path = tts.kokoro_narrate(lines, pause=pause, output_path=output_path)
        tts.play(path)
        return path
    return tts.kokoro_narrate_streaming(lines, pause=pause, output_path=output_path)


def _finish_metadata(script_path: Path, script: dict, status: str, error: str | None = None) -> None:
    script["status"] = status
    script["completed_at"] = datetime.now().astimezone().isoformat()
    if error:
        script["error"] = error
    elif (audio_path := script_path.with_suffix(".wav")).exists():
        with wave.open(str(audio_path), "rb") as audio:
            script["duration_seconds"] = audio.getnframes() / audio.getframerate()
    script_path.write_text(json.dumps(script, indent=2) + "\n")


def main() -> None:
    script_path = Path(sys.argv[1])
    script = json.loads(script_path.read_text())
    try:
        play_lines(
            script["lines"],
            pause=float(script.get("pause", 0.4)),
            output_path=script_path.with_suffix(".wav"),
        )
    except Exception as exc:
        _finish_metadata(script_path, script, "failed", str(exc))
        raise
    _finish_metadata(script_path, script, "completed")
    try:
        if PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
