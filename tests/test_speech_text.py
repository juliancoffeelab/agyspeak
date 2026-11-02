from agyspeak.speech_text import (
    NARRATION_CHUNK_LIMIT,
    chunks,
    for_speech,
    narration_chunks,
    normalize_for_speech,
    StreamingSpeech,
)
import pytest


def test_for_speech_removes_markdown_but_keeps_prose() -> None:
    source = """### Result

**Energy** is $E = mc^2$. Read [the explanation](https://example.com).

```python
print("do not read this")
```

- First point.
- Second point.
"""

    spoken = for_speech(source)

    assert "Result" in spoken
    assert "Energy is ee equals mc squared." in spoken
    assert "the explanation" in spoken
    assert "https://" not in spoken
    assert "print" not in spoken
    assert "**" not in spoken


def test_chunks_keep_sentences_in_one_markdown_block() -> None:
    assert chunks("One sentence. Another sentence!") == [
        "One sentence. Another sentence!"
    ]


def test_chunks_keep_markdown_blocks_as_render_boundaries() -> None:
    assert chunks("### Heading\n\nParagraph without punctuation") == [
        "Heading",
        "Paragraph without punctuation",
    ]


def test_normalizes_visual_notation_for_kokoro() -> None:
    source = "C. X -> Y; F_1 ≥ F_2. 🚀"

    assert normalize_for_speech(source) == (
        "cee. ex to why; eff 1 greater than or equal to eff 2."
    )


def test_chunks_keep_tiny_letter_fragments_with_their_paragraph() -> None:
    assert chunks("C. X -> Y. Done.") == ["cee. ex to why. Done."]


def test_chunks_split_only_unusually_long_blocks() -> None:
    assert chunks("one two three four", limit=10) == ["one two", "three four"]


def test_narration_has_no_artificial_pauses_between_blocks() -> None:
    script = narration_chunks(
        "Intro.\n\nAnother paragraph.\n\n---\n\n## Details\n\nFirst detail.\n\nSecond detail."
    )

    assert [chunk.text for chunk in script] == [
        "Intro.",
        "Another paragraph.",
        "Details",
        "First detail.",
        "Second detail.",
    ]
    assert [chunk.pause_before for chunk in script] == [0.0] * 5


def test_long_blocks_split_at_logical_boundaries() -> None:
    assert chunks("First sentence. Second sentence. Third sentence.", limit=34) == [
        "First sentence. Second sentence.",
        "Third sentence.",
    ]


def test_normalization_preserves_languages_and_ipa() -> None:
    source = "Дивно: /wɪərd/ [fiːəl] → clear"

    assert normalize_for_speech(source) == "Дивно: /wɪərd/ [fiːəl] to clear"


def test_model_markdown_becomes_stable_playback_chunks() -> None:
    markdown = '''## Transcription

> "Hi, could you analyze my accent and tell me what you think?"

---

## Accent Assessment

**Estimated Background:** Eastern Slavic, with strong indicators pointing toward Ukrainian.

---

## Why: Key Acoustic & Phonetic Markers

1. **Vowel Realization:** The open front vowel is articulated slightly more centrally. The lax vowel tends toward a tenser position.
2. **Prosody:** The sentence carries a more syllable-timed cadence than native English.

## Overall Impression

Your speech is fluent, clear, and very easy to understand.
'''

    script = narration_chunks(markdown)

    assert [chunk.text for chunk in script] == [
        "Transcription",
        '"Hi, could you analyze my accent and tell me what you think?"',
        "Accent Assessment",
        "Estimated Background: Eastern Slavic, with strong indicators pointing toward Ukrainian.",
        "Why: Key Acoustic and Phonetic Markers",
        "Vowel Realization: The open front vowel is articulated slightly more centrally. The lax vowel tends toward a tenser position.",
        "Prosody: The sentence carries a more syllable-timed cadence than native English.",
        "Overall Impression",
        "Your speech is fluent, clear, and very easy to understand.",
    ]
    assert all(chunk.pause_before == 0.0 for chunk in script)
    assert all(len(chunk.text) <= NARRATION_CHUNK_LIMIT for chunk in script)


def test_pronunciation_table_becomes_one_chunk_per_row() -> None:
    markdown = '''| Word | Expected (from spelling) | Actual Pronunciation | Rhymes With |
| --- | --- | --- | --- |
| said | /seɪd/ or /sæd/ | /sɛd/ | bed, red, head |
| says | /seɪz/ | /sɛz/ | fez, Pez |

English spelling strikes again!
'''

    assert chunks(markdown) == [
        "Word; Expected (from spelling); Actual Pronunciation; Rhymes With",
        "said; /seɪd/ or /sæd/; /sɛd/; bed, red, head",
        "says; /seɪz/; /sɛz/; fez, Pez",
        "English spelling strikes again!",
    ]


def test_swedish_spans_switch_language_without_english_letter_names() -> None:
    result = narration_chunks('Say **<swedish>jag</swedish>**, then <swedish>bokstaven S</swedish>.')
    assert [(part.text, part.language) for part in result] == [
        ('Say', 'en'), ('jag', 'sv'), (', then', 'en'),
        ('bokstaven S.', 'sv'),
    ]


def test_swedish_tags_span_paragraphs_and_preserve_markdown_cleanup() -> None:
    result = narration_chunks('<swedish>\n\n**Hej!**\n\nJag heter Anna.\n\n</swedish>\n\nBack to English.')
    assert [(part.text, part.language) for part in result] == [
        ('Hej!', 'sv'), ('Jag heter Anna.', 'sv'), ('Back to English.', 'en'),
    ]


def test_swedish_tags_in_fenced_code_do_not_change_language() -> None:
    assert [(part.text, part.language) for part in narration_chunks(
        '```xml\n<swedish>hej</swedish>\n```\n\nHello.'
    )] == [('Hello.', 'en')]


def test_streaming_emits_first_paragraph_before_response_finishes():
    stream = StreamingSpeech()
    assert stream.feed('First para') == []
    assert stream.feed('graph.\n\n') == narration_chunks('First paragraph.')
    assert stream.feed('Final paragraph') == []
    assert stream.finish() == narration_chunks('Final paragraph')


def test_streaming_holds_poetry_until_scope_closes_and_preserves_voice():
    stream = StreamingSpeech()
    assert stream.feed('<speak voice="Lars">\nEn rad\n\nEn annan rad') == []
    assert stream.feed('\n</speak>') == []
    chunks = stream.feed('\n\n')
    assert len(chunks) == 1
    assert chunks[0].text == 'En rad\n\nEn annan rad'
    assert chunks[0].voice == 'Lars'
    assert stream.finish() == []


@pytest.mark.parametrize('source', [
    'First paragraph.\n\nSecond paragraph.',
    '<speak voice="Lars">\nFörsta raden\n\nAndra raden\n</speak>\n\nBack to English.',
    'Before\n\n```xml\n<speak voice="Lars">\n\nhej\n\n</speak>\n```\n\nAfter.',
    '`<speak voice="Lars">` means a scope.\n\nHello.',
    'Before **<swedish>hej</swedish>**, then English.\n\nDone.',
    '| Word | Sound |\n|---|---|\n| said | /sɛd/ |\n\nDone.',
    '<speak voice="Lars">Hej</speak>. English afterward.',
    '<speak voice="Lars">Hej <speak voice="Elsa">världen</speak> igen</speak> English.',
])
def test_streaming_any_token_split_matches_complete_speech_parsing(source):
    stream = StreamingSpeech()
    emitted = []
    for character in source:
        emitted.extend(stream.feed(character))
    emitted.extend(stream.finish())
    assert emitted == narration_chunks(source)


def test_streaming_malformed_final_scope_reports_error_without_speaking_tag():
    stream = StreamingSpeech()
    assert stream.feed('Safe paragraph.\n\n<speak voice="Lars">unfinished') == narration_chunks('Safe paragraph.')
    with pytest.raises(ValueError, match='unclosed'):
        stream.finish()
