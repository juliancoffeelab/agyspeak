"""MCP server exposing agyspeak's local tools to `agy`.

Register once with:
    agy mcp add agyspeak /path/to/.venv/bin/agyspeak-mcp

Audio is rendered and played by a detached helper (see player.py) because agy
times out MCP calls after 3 minutes; the tools here return immediately.
"""

from __future__ import annotations

from mcp.server.mcpserver import MCPServer

from agyspeak import player, tts

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
    Eric, Aiden, Uncle_Fu, Ono_Anna, Sohee) is slower, roughly half real time,
    but follows a free-text `instruct` such as "whispering, conspiratorial" or
    "barely holding back laughter", and speaks Chinese, Japanese, Korean,
    German, French, Russian, Portuguese, Spanish and Italian as well as English.
    Pick Qwen when the user asks for emotion, a style, or a non-English line;
    otherwise Kokoro. Playback starts in the background and this returns at
    once; do not call again to "retry" unless the user asks.

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
    story, dialogue, or anything with more than one speaker or line. Playback
    starts within seconds and continues in the background with no gaps while
    the rest renders, so long scripts are fine. This returns immediately with
    an estimated duration; the audio is still playing after it returns, so do
    not call it again to "retry". Starting a new narration stops the previous
    one. Same rule as speak: only when the user explicitly asks to hear it.

    Args:
        lines: Ordered segments, each {"text": str, "voice": str, "speed": float,
            "instruct": str, "language": str}. Only text is required; keep the
            same voice for the same character throughout. Kokoro voice ids:
            prefix a=American, b=British; then f=female, m=male. Good ones:
            af_heart, af_bella, am_michael, bf_emma, bm_george, bm_lewis; blend
            two with "+", e.g. "af_heart+bf_emma". A Qwen speaker name (Ryan,
            Vivian, Serena, Dylan, Eric, Aiden, Uncle_Fu, Ono_Anna, Sohee)
            selects the slower Qwen engine, which honours "instruct" (emotion
            or style) and "language" for that line. Mixing engines within one
            script is fine, but Qwen renders slower than it plays, so each Qwen
            line adds a pause before it; use them for the few lines that need
            emotion, not for the narrator.
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
    to stop, pause, or be quiet."""
    return "stopped" if player.stop() else "nothing was playing"


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
