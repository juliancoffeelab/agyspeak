"""Scoped speech controls embedded in Markdown; no synthesis dependencies."""
from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import math
import re

SWEDISH_VOICES = ('Alice', 'Elsa', 'Ebba', 'Stina', 'Greta', 'Klara',
                  'Björn', 'Lars', 'Nils', 'Anton', 'Oskar', 'Viktor')
SPEECH_FIELDS = {'voice', 'language', 'speed', 'engine', 'instruct'}
TAG_PATTERN = re.compile(r'<\s*/?\s*(?:speak|swedish)\b(?:"[^"]*"|\x27[^\x27]*\x27|[^\x27">])*>', re.I)
MARKER_PATTERN = re.compile('\ue000SPEECH_[0-9]+\ue001')


def validate_options(options: dict) -> dict:
    """Validate the common options used by tags and speech scripts."""
    result = {key: value for key, value in options.items() if value is not None}
    unknown = result.keys() - SPEECH_FIELDS
    if unknown:
        raise ValueError(f"unknown speech attribute: {sorted(unknown)[0]}")
    if 'speed' in result:
        result['speed'] = float(result['speed'])
        if not math.isfinite(result['speed']) or not 0.5 <= result['speed'] <= 1.5:
            raise ValueError('speech speed must be between 0.5 and 1.5')
    if result.get('engine') not in (None, 'auto', 'kokoro', 'kokoro-sv', 'qwen', 'say'):
        raise ValueError(f"unknown speech engine: {result['engine']}")
    for key in ('voice', 'language', 'instruct'):
        if key in result and (not isinstance(result[key], str) or not result[key].strip()):
            raise ValueError(f'speech {key} must be a non-empty string')
    return result


class _Attributes(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if len(dict(attrs)) != len(attrs) or any(value is None for _, value in attrs):
            raise ValueError('speech attributes need unique names and values')
        self.options = validate_options(dict(attrs))

    def handle_startendtag(self, tag, attrs):
        raise ValueError('speech tags require a closing tag')


@dataclass(frozen=True)
class SpeechTag:
    raw: str

    def control(self) -> tuple[str, bool, dict]:
        closing = bool(re.match(r'<\s*/', self.raw))
        name = re.match(r'<\s*/?\s*(\w+)', self.raw).group(1).lower()
        if closing:
            if not re.fullmatch(r'<\s*/\s*(speak|swedish)\s*>', self.raw, re.I):
                raise ValueError('invalid closing speech tag')
            return name, True, {}
        parser = _Attributes()
        parser.feed(self.raw)
        if not hasattr(parser, 'options'):
            raise ValueError('invalid speech tag')
        options = parser.options
        if name == 'swedish':
            if options:
                raise ValueError('<swedish> does not take attributes; use <speak>')
            options = {'language': 'sv'}
        elif options.get('voice') in SWEDISH_VOICES and 'language' not in options:
            options['language'] = 'sv'
        return name, False, options


def protect_tags(markdown: str) -> tuple[str, dict[str, SpeechTag]]:
    """Keep custom tags out of Markdown's HTML-block parser."""
    tags = {}
    def replace(match):
        marker = f'\ue000SPEECH_{len(tags)}\ue001'
        tags[marker] = SpeechTag(match.group())
        return marker
    return TAG_PATTERN.sub(replace, markdown), tags


def visible_text(text: str, tags: dict[str, SpeechTag], literal: bool = False) -> str:
    return MARKER_PATTERN.sub(
        lambda m: (tags[m.group()].raw if literal else '') if m.group() in tags else m.group(), text
    )
