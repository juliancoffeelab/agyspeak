"""Make common model-generated LaTeX readable in a plain terminal."""

from __future__ import annotations

import re
import unicodedata

from pylatexenc.latex2text import LatexNodes2Text

_DOLLAR_DISPLAY = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_DOLLAR_INLINE = re.compile(r"(?<!\\)(?<!\$)\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)")
_BRACKET_DISPLAY = re.compile(r"\\\[(.+?)\\\]", re.DOTALL)
_PAREN_INLINE = re.compile(r"\\\((.+?)\\\)")
_CODE_SPAN = re.compile(r"(`+)(.*?)\1", re.DOTALL)

_CONVERTER = LatexNodes2Text()
_OPERATORS = "→←↔⇒⇐⇔⟶⟵≈≠≤≥×·±="


def _plain_math(source: str) -> str:
    text = _CONVERTER.latex_to_text(source.strip())
    # Mathematical bold/italic letters often use a fallback font whose glyph
    # metrics overlap terminal cells, especially when mixed with IPA.
    text = "".join(
        unicodedata.normalize("NFKC", char)
        if 0x1D400 <= ord(char) <= 0x1D7FF
        else char
        for char in text
    )
    text = text.replace("⟶", "→").replace("⟵", "←")
    text = re.sub(rf"\s*([{_OPERATORS}])\s*", r" \1 ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def for_terminal(markdown: str) -> str:
    """Replace display-math blocks with readable plain text and Unicode."""
    code_spans: list[str] = []

    def protect_code(match: re.Match) -> str:
        code_spans.append(match.group(0))
        return f"\x00AGYSPEAK_CODE_{len(code_spans) - 1}\x00"

    def display(match: re.Match) -> str:
        return f"\n\n{_plain_math(match.group(1))}\n\n"

    def inline(match: re.Match) -> str:
        source = match.group(1)
        # Avoid treating currency ranges such as "$5 to $10" as math.
        if source.lstrip()[:1].isdigit() and not re.search(r"[\\_^{}=]", source):
            return match.group(0)
        return _plain_math(source)

    markdown = _CODE_SPAN.sub(protect_code, markdown)
    markdown = _DOLLAR_DISPLAY.sub(display, markdown)
    markdown = _BRACKET_DISPLAY.sub(display, markdown)
    markdown = _PAREN_INLINE.sub(lambda match: _plain_math(match.group(1)), markdown)
    markdown = _DOLLAR_INLINE.sub(inline, markdown)
    for index, code in enumerate(code_spans):
        markdown = markdown.replace(f"\x00AGYSPEAK_CODE_{index}\x00", code)
    return markdown
