"""Speech request metadata and playback helpers used by the harness service."""

from __future__ import annotations

import json
import threading
import wave
from datetime import datetime
from pathlib import Path

from agyspeak import tts
from agyspeak.speech_markup import SPEECH_FIELDS, validate_options

WORDS_PER_SECOND = 2.6  # rough Kokoro pace at speed 1.0, for the estimate we return


def stop() -> bool:
    """Cancel queued or active speech without unloading the worker."""
    from agyspeak import worker

    return worker.stop()


def unload(engine: str = "all") -> bool:
    """Stop speech and release model memory owned by the harness."""
    from agyspeak import worker

    return worker.unload(engine)


def _create_script(lines: list[dict], pause: float) -> tuple[Path, float]:
    def estimate_duration() -> float:
        duration = 0.0
        for index, line in enumerate(lines):
            words = len(str(line.get("text", "")).split())
            speed = max(0.1, float(line.get("speed") or 1.0))
            duration += words / (WORDS_PER_SECOND * speed)
            if index:
                duration += tts.pause_before(line, pause)
        return duration

    lines = [{**line, **validate_options({key: value for key, value in line.items() if key in SPEECH_FIELDS})} for line in lines]
    tts.SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    created = datetime.now()
    request_id = created.strftime("%Y%m%d-%H%M%S-%f")
    script = tts.SPEECH_DIR / f"speech_{request_id}.json"
    audio = script.with_suffix(".wav")
    estimate = estimate_duration()
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
    return script, estimate


def start(lines: list[dict], pause: float = 0.4) -> tuple[Path, float]:
    """Queue a complete script with the harness service."""
    from agyspeak import worker

    script, estimate = _create_script(lines, pause)
    worker.submit_script(script)
    return script, estimate


class NarrationStream:
    """One reply's append-only narration; stop/replacement rejects later chunks."""

    def __init__(self) -> None:
        from agyspeak import worker

        self.path, _ = _create_script([], pause=0.0)
        self.closed = False
        worker.start_stream(self.path)

    def append(self, lines: list[dict]) -> None:
        from agyspeak import worker

        if self.closed or not lines:
            return
        lines = [{**line, **validate_options({k: v for k, v in line.items() if k in SPEECH_FIELDS})} for line in lines]
        if not worker.append_stream(self.path, lines):
            self.closed = True

    def finish(self, *, cancel: bool = False) -> None:
        from agyspeak import worker

        if not self.closed:
            worker.finish_stream(self.path, cancel=cancel)
            self.closed = True


def play_lines(
    lines: list[dict],
    pause: float = 0.4,
    output_path: Path | None = None,
    stop_event: threading.Event | None = None,
) -> Path:
    """Stream Kokoro scripts; buffer scripts containing Qwen before playback."""
    if any(tts.line_engine(line) == "qwen" for line in lines):
        path = tts.kokoro_narrate(
            lines, pause=pause, output_path=output_path, stop_event=stop_event
        )
        tts.play(path, stop_event=stop_event)
        return path
    return tts.kokoro_narrate_streaming(
        lines, pause=pause, output_path=output_path, stop_event=stop_event
    )


def _finish_metadata(script_path: Path, script: dict, status: str, error: str | None = None) -> None:
    script["status"] = status
    script["completed_at"] = datetime.now().astimezone().isoformat()
    if error:
        script["error"] = error
    elif (audio_path := script_path.with_suffix(".wav")).exists():
        with wave.open(str(audio_path), "rb") as audio:
            script["duration_seconds"] = audio.getnframes() / audio.getframerate()
    script_path.write_text(json.dumps(script, indent=2) + "\n")
