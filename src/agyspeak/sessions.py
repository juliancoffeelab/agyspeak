"""Saved Antigravity session preferences and atomic last-session writes."""

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODEL = "gemini-3.8-flash"
DEFAULT_EFFORT = "medium"
EFFORT_LEVELS = ("low", "medium", "high")


@dataclass(frozen=True)
class SessionPreferences:
    conversation_id: str | None = None
    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT

    @classmethod
    def from_record(cls, record: dict) -> "SessionPreferences":
        model = record.get("model") or DEFAULT_MODEL
        legacy = re.fullmatch(r"(.+)-(low|medium|high)", model)
        effort = record.get("effort") or (legacy[2] if legacy else DEFAULT_EFFORT)
        if effort not in EFFORT_LEVELS:
            effort = DEFAULT_EFFORT
        return cls(
            conversation_id=record.get("conversation_id") or record.get("id"),
            model=legacy[1] if legacy else model,
            effort=effort,
        )

    def to_record(self) -> dict:
        return {"conversation_id": self.conversation_id, "model": self.model, "effort": self.effort}


def write_last_session(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            json.dump(record, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
