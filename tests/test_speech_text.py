from agyspeak.speech_text import (
    SECTION_PAUSE,
    chunks,
    for_speech,
    narration_chunks,
    normalize_for_speech,
)


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


def test_chunks_splits_markdown_blocks() -> None:
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


def test_narration_pauses_before_sections_but_not_paragraphs() -> None:
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
    assert [chunk.pause_before for chunk in script] == [
        0.0,
        0.0,
        SECTION_PAUSE,
        0.0,
        0.0,
    ]


def test_normalization_preserves_languages_and_ipa() -> None:
    source = "Дивно: /wɪərd/ [fiːəl] → clear"

    assert normalize_for_speech(source) == "Дивно: /wɪərd/ [fiːəl] to clear"
