"""Turn model Markdown into short, natural chunks for speech."""

from __future__ import annotations

import re
import unicodedata

from dataclasses import dataclass

from agyspeak.terminal_math import parsed_text_blocks, text_blocks

_SUBSCRIPTED_CAPITAL = re.compile(r"(?<!\w)([A-Z])_([0-9]+)(?!\w)")
_ISOLATED_CAPITAL = re.compile(r"(?<!\w)([B-HJ-NP-TV-Z])(?!\w)")
_SQUARED = re.compile(r"\^2(?!\w)")
_CUBED = re.compile(r"\^3(?!\w)")
SECTION_PAUSE = 0.35


@dataclass(frozen=True)
class SpeechChunk:
    text: str
    pause_before: float = 0.0

_LETTER_NAMES = {
    "A": "ay",
    "B": "bee",
    "C": "cee",
    "D": "dee",
    "E": "ee",
    "F": "eff",
    "G": "gee",
    "H": "aitch",
    "I": "eye",
    "J": "jay",
    "K": "kay",
    "L": "ell",
    "M": "em",
    "N": "en",
    "O": "oh",
    "P": "pee",
    "Q": "cue",
    "R": "ar",
    "S": "ess",
    "T": "tee",
    "U": "you",
    "V": "vee",
    "W": "double-u",
    "X": "ex",
    "Y": "why",
    "Z": "zee",
}

_SPOKEN_SYMBOLS = (
    ("⟷", " both ways with "),
    ("↔", " both ways with "),
    ("⇔", " is equivalent to "),
    ("⟶", " to "),
    ("→", " to "),
    ("->", " to "),
    ("⇒", " implies "),
    ("⟵", " from "),
    ("←", " from "),
    ("<-", " from "),
    ("≥", " greater than or equal to "),
    ("≤", " less than or equal to "),
    ("≠", " not equal to "),
    ("≈", " approximately "),
    ("∝", " is proportional to "),
    ("±", " plus or minus "),
    ("×", " times "),
    ("÷", " divided by "),
    ("∞", " infinity "),
    ("∑", " sum of "),
    ("=", " equals "),
    ("+", " plus "),
    ("&", " and "),
)


def _letter_with_subscript(match: re.Match) -> str:
    return f"{_LETTER_NAMES[match.group(1)]} {match.group(2)}"


def _safe_char(char: str) -> str:
    """Keep language/IPA text and punctuation, but discard TTS-hostile symbols."""
    if char in "\n\t":
        return char
    category = unicodedata.category(char)
    if category[0] in {"L", "M", "N", "P", "Z"} or category == "Sc":
        return char
    return " "


def normalize_for_speech(text: str) -> str:
    """Expand visual notation and remove characters Kokoro cannot pronounce."""
    text = unicodedata.normalize("NFKC", text)
    text = _SQUARED.sub(" squared", text)
    text = _CUBED.sub(" cubed", text)
    for symbol, spoken in _SPOKEN_SYMBOLS:
        text = text.replace(symbol, spoken)
    text = _SUBSCRIPTED_CAPITAL.sub(_letter_with_subscript, text)
    text = _ISOLATED_CAPITAL.sub(lambda match: _LETTER_NAMES[match.group(1)], text)
    text = "".join(_safe_char(char) for char in text)
    return re.sub(r"\s+", " ", text).strip()


def for_speech(markdown: str) -> str:
    """Return readable prose without Markdown syntax or fenced source code."""
    paragraphs = [normalize_for_speech(block) for block in text_blocks(markdown)]
    return "\n\n".join(part for part in paragraphs if part)


def narration_chunks(markdown: str, limit: int = 1200) -> list[SpeechChunk]:
    """Keep Markdown blocks intact and pause only at section boundaries."""
    result: list[SpeechChunk] = []
    section_break = False
    for block in parsed_text_blocks(markdown):
        if block.kind == "break":
            section_break = True
            continue
        spoken = normalize_for_speech(block.text)
        if not spoken:
            continue
        pause = SECTION_PAUSE if section_break or block.kind == "heading" else 0.0
        section_break = False
        if len(spoken) <= limit:
            result.append(SpeechChunk(spoken, pause))
            continue
        words = spoken.split()
        current: list[str] = []
        for word in words:
            if current and len(" ".join((*current, word))) > limit:
                result.append(SpeechChunk(" ".join(current), pause))
                pause = 0.0
                current = []
            current.append(word)
        if current:
            result.append(SpeechChunk(" ".join(current), pause))
    return result


def chunks(markdown: str, limit: int = 1200) -> list[str]:
    """Return only the spoken text chunks (use narration_chunks for pacing)."""
    return [chunk.text for chunk in narration_chunks(markdown, limit)]
