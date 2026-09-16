"""Make common model-generated LaTeX readable in a plain terminal."""

from __future__ import annotations

import re

from pylatexenc.latex2text import LatexNodes2Text

_DOLLAR_DISPLAY = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_BRACKET_DISPLAY = re.compile(r"\\\[(.+?)\\\]", re.DOTALL)
_PAREN_INLINE = re.compile(r"\\\((.+?)\\\)")

_CONVERTER = LatexNodes2Text()
_OPERATORS = "→←↔⇒⇐⇔⟶⟵≈≠≤≥×·±="


def _plain_math(source: str) -> str:
    text = _CONVERTER.latex_to_text(source.strip())
    text = text.replace("⟶", "→").replace("⟵", "←")
    text = re.sub(rf"\s*([{_OPERATORS}])\s*", r" \1 ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def for_terminal(markdown: str) -> str:
    """Replace display-math blocks with readable plain text and Unicode."""
    def display(match: re.Match) -> str:
        return f"\n\n{_plain_math(match.group(1))}\n\n"

    markdown = _DOLLAR_DISPLAY.sub(display, markdown)
    markdown = _BRACKET_DISPLAY.sub(display, markdown)
    return _PAREN_INLINE.sub(lambda match: _plain_math(match.group(1)), markdown)
