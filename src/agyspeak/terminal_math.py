"""Render Markdown and common LaTeX cleanly in a terminal or as speech."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.texmath import texmath_plugin
from pylatexenc.latex2text import LatexNodes2Text
from rich.markdown import Markdown

_CONVERTER = LatexNodes2Text()
_OPERATORS = "→←↔⇒⇐⇔⟶⟵≈≠≤≥×·±="


def _parser() -> MarkdownIt:
    return (
        MarkdownIt()
        .enable("strikethrough")
        .enable("table")
        .use(dollarmath_plugin, allow_digits=False, double_inline=True)
        .use(texmath_plugin, delimiters="brackets")
    )


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


def _convert_inline_math(token: Token) -> None:
    for child in token.children or []:
        if child.type == "math_inline":
            child.type = "text"
            child.tag = ""
            child.markup = ""
            child.content = _plain_math(child.content)
        _convert_inline_math(child)


def terminal_tokens(markdown: str) -> list[Token]:
    """Parse Markdown and replace math nodes with terminal-safe text nodes."""
    result: list[Token] = []
    for token in _parser().parse(markdown):
        if token.type.startswith("math_block"):
            result.extend(
                [
                    Token("paragraph_open", "p", 1),
                    Token(
                        "inline",
                        "",
                        0,
                        children=[Token("text", "", 0, content=_plain_math(token.content))],
                    ),
                    Token("paragraph_close", "p", -1),
                ]
            )
            continue
        _convert_inline_math(token)
        result.append(token)
    return result


class TerminalMarkdown(Markdown):
    """Rich Markdown with structural LaTeX parsing and plain-text math output."""

    def __init__(self, markup: str, **kwargs) -> None:  # noqa: ANN003
        super().__init__(markup, **kwargs)
        self.parsed = terminal_tokens(markup)


def _inline_text(tokens: list[Token]) -> str:
    parts: list[str] = []
    for token in tokens:
        if token.type == "math_inline":
            parts.append(_plain_math(token.content))
        elif token.type in {"text", "code_inline"}:
            parts.append(token.content)
        elif token.type in {"softbreak", "hardbreak"}:
            parts.append(" ")
        elif token.type == "image":
            parts.append(_inline_text(token.children or []) or token.content)
        elif token.children:
            parts.append(_inline_text(token.children))
    return "".join(parts)


@dataclass(frozen=True)
class TextBlock:
    kind: str
    text: str


def parsed_text_blocks(markdown: str) -> list[TextBlock]:
    """Extract typed prose blocks from parsed Markdown, omitting source code."""
    blocks: list[TextBlock] = []
    kind = "paragraph"
    for token in _parser().parse(markdown):
        if token.type == "heading_open":
            kind = "heading"
            continue
        if token.type == "hr":
            blocks.append(TextBlock("break", ""))
            continue
        if token.type == "inline":
            text = _inline_text(token.children or []).strip()
        elif token.type.startswith("math_block"):
            text = _plain_math(token.content)
        else:
            continue
        if text:
            blocks.append(TextBlock(kind, text))
        kind = "paragraph"
    return blocks


def text_blocks(markdown: str) -> list[str]:
    """Extract spoken prose strings from parsed Markdown."""
    return [block.text for block in parsed_text_blocks(markdown) if block.text]
