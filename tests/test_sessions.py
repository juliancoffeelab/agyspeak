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


def test_save_session_includes_voice_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    last_session = tmp_path / "last_session.json"
    monkeypatch.setattr(cli, "LAST_SESSION", last_session)
    monkeypatch.setattr(cli, "STATE_DIR", tmp_path)
    client = cli.AgyClient.__new__(cli.AgyClient)
    client.conversation_id = "conversation-id"
    client.model = "model-id"

    cli._save_session(client, cli.VoiceMode(voice="bm_fable", enabled=True))

    assert json.loads(last_session.read_text()) == {
        "conversation_id": "conversation-id",
        "model": "model-id",
        "voice": "bm_fable",
        "voice_mode": True,
    }


def test_voice_change_before_first_turn_preserves_last_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    last_session = tmp_path / "last_session.json"
    last_session.write_text(json.dumps({"conversation_id": "keep-me", "model": "old"}))
    monkeypatch.setattr(cli, "LAST_SESSION", last_session)
    monkeypatch.setattr(cli, "STATE_DIR", tmp_path)
    client = cli.AgyClient.__new__(cli.AgyClient)
    client.conversation_id = None
    client.model = "new"

    cli._save_session(client, cli.VoiceMode(voice="am_echo", enabled=False))

    assert json.loads(last_session.read_text())["conversation_id"] == "keep-me"
