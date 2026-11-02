"""Turn model Markdown into short, natural chunks for speech."""

from __future__ import annotations

import re
import unicodedata

from dataclasses import dataclass, replace
from agyspeak.speech_markup import protect_tags, MARKER_PATTERN, TAG_PATTERN

from agyspeak.terminal_math import parsed_text_blocks

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
    language: str = "en"
    voice: str | None = None
    engine: str | None = None
    speed: float | None = None
    instruct: str | None = None

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


def normalize_for_speech(text: str, language: str = "en", *, preserve_lines: bool = False) -> str:
    """Expand visual notation and remove characters Kokoro cannot pronounce."""
    text = unicodedata.normalize("NFKC", text)
    text = _SQUARED.sub(" squared", text)
    text = _CUBED.sub(" cubed", text)
    for symbol, spoken in _SPOKEN_SYMBOLS:
        text = text.replace(symbol, spoken)
    if language == "en":
        text = _SUBSCRIPTED_CAPITAL.sub(_letter_with_subscript, text)
        text = _ISOLATED_CAPITAL.sub(lambda match: _LETTER_NAMES[match.group(1)], text)
    text = "".join(_safe_char(char) for char in text)
    if preserve_lines:
        return "\n".join(re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")).strip()
    return re.sub(r"\s+", " ", text).strip()


def for_speech(markdown: str) -> str:
    """Return readable prose without Markdown syntax or fenced source code."""
    return "\n\n".join(chunk.text for chunk in narration_chunks(markdown, limit=10**9))


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

    marked, tags = protect_tags(markdown)
    stack: list[tuple[str, dict]] = []
    options: dict = {}
    result: list[SpeechChunk] = []
    pending: list[str] = []

    def flush():
        if not pending:
            return
        explicit = any(name == "speak" for name, _ in stack)
        language = options.get("language", "en")
        spoken = normalize_for_speech("\n\n".join(pending), language, preserve_lines=explicit)
        pending.clear()
        if not spoken:
            return
        if result and not any(char.isalnum() for char in spoken):
            result[-1] = replace(result[-1], text=result[-1].text + spoken)
            return
        parts = [spoken] if explicit else split_spoken(spoken)
        result.extend(SpeechChunk(part, **options) for part in parts)

    for block in parsed_text_blocks(marked, speech_tags=tags, line_breaks=True):
        if block.kind == "break":
            continue
        for span in re.split(f"({MARKER_PATTERN.pattern})", block.text):
            if span in tags:
                flush()
                name, closing, attrs = tags[span].control()
                if closing:
                    if not stack or stack[-1][0] != name:
                        raise ValueError(f"unmatched </{name}> speech tag")
                    _, options = stack.pop()
                else:
                    stack.append((name, options))
                    options = {**options, **attrs}
            elif span.strip():
                pending.append(span)
        if not any(name == "speak" for name, _ in stack):
            flush()
    flush()
    if stack:
        raise ValueError(f"unclosed <{stack[-1][0]}> speech tag")
    return result


def chunks(markdown: str, limit: int = 1200) -> list[str]:
    """Return only the spoken text chunks (use narration_chunks for pacing)."""
    return [chunk.text for chunk in narration_chunks(markdown, limit)]


class StreamingSpeech:
    """Release complete prose/scopes while retaining Markdown parsing context.

    Reparse the accumulated source at block boundaries, rather than parsing each
    token independently: fences, tables, nested voices, and split tags still mean
    the same thing. The unfinished tail is held until another boundary or EOF.
    """

    def __init__(self) -> None:
        self.source = ""
        self.boundary = 0
        self.emitted = 0

    def feed(self, text: str) -> list[SpeechChunk]:
        self.source += text
        candidates = [m.end() for m in re.finditer(r"\n[ \t]*\n", self.source) if m.end() > self.boundary]
        # A standalone explicit scope may span many paragraphs. Wait for its
        # closing tag and a little lookahead so following punctuation stays with it.
        tail = self.source[self.boundary:].lstrip()
        if re.match(r"<\s*(speak|swedish)\b", tail, re.I):
            for match in TAG_PATTERN.finditer(self.source, self.boundary):
                if not re.match(r"<\s*/", match.group()):
                    continue
                end = match.end()
                while end < len(self.source) and (self.source[end].isspace() or self.source[end] in ".,!?;:…"):
                    end += 1
                if end < len(self.source):
                    candidates.append(match.end())
        for end in sorted(set(candidates), reverse=True):
            try:
                parsed = narration_chunks(self.source[:end])
            except ValueError:
                # An outer speech scope or a tag split across tokens may still
                # be incomplete. Errors in the final source are reported at EOF.
                continue
            ready = parsed[self.emitted:]
            self.emitted = len(parsed)
            self.boundary = end
            return ready
        return []

    def finish(self) -> list[SpeechChunk]:
        parsed = narration_chunks(self.source)
        ready = parsed[self.emitted:]
        self.emitted = len(parsed)
        return ready
