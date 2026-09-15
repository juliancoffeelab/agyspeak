"""MCP server exposing agyspeak's local tools to `agy`.

Register once with:
    agy mcp add agyspeak /path/to/.venv/bin/agyspeak-mcp
"""

from __future__ import annotations

import subprocess

from mcp.server.mcpserver import MCPServer

DEFAULT_VOICE = "Samantha"

server = MCPServer("agyspeak")


@server.tool()
def speak(text: str, voice: str = DEFAULT_VOICE, rate: int | None = None) -> str:
    """Read text aloud on the user's Mac using the system TTS voice.

    Only call this when the user explicitly asks to hear something spoken
    (for example "say that", "read it back", "pronounce this"). Never call it
    on your own initiative, and do not read out your whole reply unless asked.

    Args:
        text: The exact text to speak. Keep it short, a phrase or a sentence or two.
        voice: macOS voice name. Defaults to Samantha (American English).
        rate: Words per minute. Omit for the voice's natural speed.
    """
    argv = ["say", "-v", voice]
    if rate:
        argv += ["-r", str(rate)]
    argv.append(text)
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode != 0:
        return f"say failed: {result.stderr.strip() or result.returncode}"
    return f"spoke {len(text.split())} words with voice {voice}"


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
