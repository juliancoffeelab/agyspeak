"""MCP server exposing agyspeak's local tools to `agy`.

Register once with:
    agy mcp add agyspeak /path/to/.venv/bin/agyspeak-mcp

Audio is rendered and played by the parent agyspeak harness because agy may
restart this MCP server between turns.
"""

from __future__ import annotations

import json

from mcp.server.mcpserver import MCPServer

from agyspeak import library, player, tts, worker

server = MCPServer("agyspeak")


def _reason(exc: Exception) -> str:
    text = str(exc)
    if any(k in text for k in ("404", "Entry Not Found", "local cache")):
        return "unknown voice"
    if isinstance(exc, ValueError) and "unknown voice" in text:
        return text
    return text.splitlines()[0] if text else type(exc).__name__


@server.tool()
def speak(
    text: str,
    voice: str = tts.DEFAULT_KOKORO_VOICE,
    speed: float = 1.0,
    engine: str = "auto",
    instruct: str | None = None,
    language: str = "auto",
) -> str:
    """Read text aloud on the user's machine with a local neural TTS voice.

    Only call this when the user explicitly asks to hear something spoken
    (for example "say that", "read it back", "pronounce this"). Never call it
    on your own initiative, and do not read out your whole reply unless asked.

    Two engines. Kokoro (voices like af_heart) is fast and clear; intonation
    comes only from punctuation. Qwen (speakers Ryan, Vivian, Serena, Dylan,
    Eric, Aiden, Uncle_Fu, Ono_Anna, Sohee) renders several times slower than
    playback, but follows a free-text `instruct` such as "whispering,
    conspiratorial" or "barely holding back laughter". It speaks Chinese,
    Japanese, Korean, German, French, Russian, Portuguese, Spanish and Italian
    as well as English. Pick Qwen for a short line that needs emotion, a style,
    or another language. Use Kokoro for ordinary speech and longer passages.
    Playback starts in the background and this returns at once; do not call
    again to "retry" unless the user asks.

    Args:
        text: The exact text to speak. Keep it short, a phrase or a sentence or two.
        voice: Kokoro voice id (see narrate) or a Qwen speaker name. For engine
            "say" a macOS voice name.
        speed: Playback speed multiplier, 0.5 (slow, for learners) to 1.5.
        engine: "auto" (from the voice name), "kokoro", "qwen", or "say"
            (macOS built-in, instant, robotic).
        instruct: Qwen only. Free-text emotion or style direction.
        language: Qwen only. Language name such as "Japanese", or "auto".
    """
    try:
        if engine == "say":
            say_voice = voice if "_" not in voice else tts.DEFAULT_SAY_VOICE
            player.stop()
            tts.say(text, voice=say_voice, rate=int(175 * speed) if speed != 1.0 else None)
            return f"spoke {len(text.split())} words with say/{say_voice}"
        line = {"text": text, "voice": voice, "speed": speed, "instruct": instruct, "language": language}
        if engine != "auto":
            line["engine"] = engine
        _, seconds = player.start([line])
        used = engine if engine != "auto" else ("qwen" if voice in tts.QWEN_SPEAKERS else "kokoro")
        return f"speaking {len(text.split())} words with {used}/{voice}, about {seconds:.0f}s"
    except Exception as exc:  # report to the model instead of crashing the server
        return f"speak failed ({engine}/{voice}): {_reason(exc)}"


@server.tool()
def narrate(lines: list[dict], pause: float = 0.4) -> str:
    """Read a multi-voice script aloud as one continuous performance.

    Use this instead of repeated speak() calls whenever the user asks for a
    story, dialogue, or anything with more than one speaker or line. A
    Kokoro-only script starts after its first line renders, then renders later
    lines during playback. A script containing Qwen renders completely before
    playback, which avoids pauses between lines. This tool still returns
    immediately; Qwen audio may start much later. Do not call it again to
    "retry". Starting a new narration stops the previous one. Same rule as
    speak: only when the user explicitly asks to hear it.

    Args:
        lines: Ordered segments, each {"text": str, "voice": str, "speed": float,
            "engine": str, "instruct": str, "language": str}. Only text is
            required; keep the same voice for the same character throughout.
            Kokoro voice ids:
            prefix a=American, b=British; then f=female, m=male. Good ones:
            af_heart, af_bella, am_michael, bf_emma, bm_george, bm_lewis; blend
            two with "+", e.g. "af_heart+bf_emma". A Qwen speaker name (Ryan,
            Vivian, Serena, Dylan, Eric, Aiden, Uncle_Fu, Ono_Anna, Sohee)
            selects the slower Qwen engine, which honours "instruct" (emotion
            or style) and "language" for that line. Mixing engines within one
            script is fine. Any Qwen line makes the whole script render before
            playback, so use Qwen for the few lines that need emotion, not for
            the narrator.
        pause: Silence between lines in seconds.
    """
    try:
        _, seconds = player.start(lines, pause=pause)
        voices = sorted({str(l.get("voice") or tts.DEFAULT_KOKORO_VOICE) for l in lines})
        return (
            f"narrating {len(lines)} lines with voices {', '.join(voices)}; "
            f"playback runs in the background for about {seconds:.0f}s"
        )
    except Exception as exc:
        return f"narrate failed: {_reason(exc)}"


@server.tool()
def stop_speaking() -> str:
    """Stop any speech or narration currently playing. Call when the user asks
    to stop, pause, or be quiet. Models remain loaded. If a line is currently
    rendering, it finishes silently before the harness accepts more speech."""
    return "stopped" if player.stop() else "nothing was playing"


@server.tool()
def list_audio(kind: str = "all", limit: int = 10) -> str:
    """List recent microphone recordings and generated speech in agyspeak's cache.

    Call when the user asks what audio is available, or before replaying an
    older item. `kind` is "all", "recording", or "speech". Returns newest first.
    """
    try:
        return json.dumps(library.list_audio(kind, limit), ensure_ascii=False)
    except Exception as exc:
        return f"list audio failed: {_reason(exc)}"


@server.tool()
def replay_audio(kind: str, audio_id: str = "latest") -> str:
    """Replay saved agyspeak audio on the user's machine.

    Only call when the user explicitly asks to hear a recording or generated
    speech. `kind` is "recording" or "speech". Use an id from list_audio(), or
    "latest". Playback runs in the background and replaces current speech.
    """
    try:
        path = library.resolve_audio(kind, audio_id)
        worker.replay(path)
        return f"replaying {kind}/{audio_id}"
    except Exception as exc:
        return f"replay failed: {_reason(exc)}"


@server.tool()
def unload_speech() -> str:
    """Stop speech and unload all speech models from memory.

    Call only when the user asks to unload, shut down, or free speech-model
    memory. The harness remains available, so a later speech call reloads it.
    """
    if player.unload():
        return "speech models queued for unloading"
    return "speech service was not running"


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
