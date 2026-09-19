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
_SPEECH_BOUNDARY = re.compile(r"(?<=[.!?…:;])\s+")
NARRATION_CHUNK_LIMIT = 280


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


def narration_chunks(
    markdown: str, limit: int = NARRATION_CHUNK_LIMIT
) -> list[SpeechChunk]:
    """Keep Markdown blocks distinct and split long ones near punctuation."""
    def split_spoken(text: str) -> list[str]:
        """Pack sentence-like units, falling back to words for oversized ones."""
        units: list[str] = []
        for sentence in _SPEECH_BOUNDARY.split(text):
            if len(sentence) <= limit:
                units.append(sentence)
                continue
            words = sentence.split()
            current: list[str] = []
            for word in words:
                if current and len(" ".join((*current, word))) > limit:
                    units.append(" ".join(current))
                    current = []
                current.append(word)
            if current:
                units.append(" ".join(current))

        chunks: list[str] = []
        for unit in units:
            combined = f"{chunks[-1]} {unit}" if chunks else unit
            if chunks and len(combined) <= limit:
                chunks[-1] = combined
            else:
                chunks.append(unit)
        return chunks

    result: list[SpeechChunk] = []
    for block in parsed_text_blocks(markdown):
        if block.kind == "break":
            continue
        spoken = normalize_for_speech(block.text)
        if not spoken:
            continue
        result.extend(SpeechChunk(part) for part in split_spoken(spoken))
    return result


def chunks(markdown: str, limit: int = 1200) -> list[str]:
    """Return only the spoken text chunks (use narration_chunks for pacing)."""
    return [chunk.text for chunk in narration_chunks(markdown, limit)]
