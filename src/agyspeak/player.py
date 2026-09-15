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
import time
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
    script = tts.SPEECH_DIR / f"script_{time.strftime('%Y%m%d-%H%M%S')}.json"
    script.write_text(json.dumps({"lines": lines, "pause": pause}))
    proc = subprocess.Popen(
        [sys.executable, "-m", "agyspeak.player", str(script)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=(tts.SPEECH_DIR / "player.log").open("ab"),
        start_new_session=True,  # survives the MCP server being killed by agy
    )
    PID_FILE.write_text(str(proc.pid))
    words = sum(len(str(line.get("text", "")).split()) for line in lines)
    estimate = words / WORDS_PER_SECOND + pause * max(len(lines) - 1, 0)
    return script, estimate


def main() -> None:
    script = json.loads(Path(sys.argv[1]).read_text())
    tts.kokoro_narrate_streaming(script["lines"], pause=float(script.get("pause", 0.4)))
    try:
        if PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
