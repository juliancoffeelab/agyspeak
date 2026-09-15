import json
from pathlib import Path

import pytest
import typer

from agyspeak import cli


@pytest.fixture
def sessions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "sessions.jsonl"
    rows = [
        {"id": "aaaa1111-x", "model": "m", "title": "", "started": "1", "updated": "1"},
        {"id": "aaaa2222-x", "model": "m", "title": "", "started": "2", "updated": "2"},
        {"id": "bbbb3333-x", "model": "m", "title": "", "started": "3", "updated": "3"},
    ]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    monkeypatch.setattr(cli, "SESSIONS", path)
    return path


def test_unique_prefix_expands(sessions: Path) -> None:
    assert cli._resolve_conversation("bbbb") == "bbbb3333-x"


def test_unknown_prefix_is_refused(sessions: Path) -> None:
    with pytest.raises(typer.Exit):
        cli._resolve_conversation("bbbbb3333")  # the typo that bit us


def test_ambiguous_prefix_is_refused(sessions: Path) -> None:
    with pytest.raises(typer.Exit):
        cli._resolve_conversation("aaaa")
