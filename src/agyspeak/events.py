"""Application events emitted by Antigravity chat, independent of ACP wire data."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolProgress:
    call_id: str
    title: str
    arguments: dict


@dataclass(frozen=True)
class AudioPart:
    index: int
    total: int
    path: Path


@dataclass(frozen=True)
class AuthenticationRequired:
    pass


ChatEvent = TextDelta | ToolProgress | AudioPart | AuthenticationRequired
