import pytest
import numpy as np
from types import SimpleNamespace
from agyspeak.speech_text import narration_chunks
from agyspeak import cli, tts
from test_terminal_math import render


def test_scopes_inherit_and_restore_voice_and_speed():
    parts = narration_chunks('Before <speak voice="Lars" speed="0.9">Hej <speak voice="Elsa">världen</speak> igen</speak> after.')
    assert [(p.text, p.voice, p.speed, p.language) for p in parts] == [
        ('Before', None, None, 'en'), ('Hej', 'Lars', .9, 'sv'),
        ('världen', 'Elsa', .9, 'sv'), ('igen', 'Lars', .9, 'sv'), ('after.', None, None, 'en')]


def test_explicit_block_preserves_poetry_and_avoids_arbitrary_chunks():
    poem = 'En rad\nEn annan rad\n\n' + 'En längre rad. ' * 40
    parts = narration_chunks(f'<speak voice="Lars">\n{poem}\n</speak>')
    assert len(parts) == 1
    assert parts[0].text == poem.strip()


def test_render_hides_controls_and_preserves_markdown_and_literal_code():
    text = render('<speak voice="Lars">\n**Hej**\n\nVärlden\n</speak>\n\n`<speak voice="Elsa">`\n\n```xml\n<swedish>hej</swedish>\n```')
    assert 'Hej' in text and 'Världen' in text
    assert '<speak voice="Lars">' not in text
    assert '<speak voice="Elsa">' in text
    assert '<swedish>hej</swedish>' in text
    assert '\ue000' not in text


@pytest.mark.parametrize('source', [
    '<speak speed="nan">Hej</speak>', '<speak typo="Lars">Hej</speak>',
    '<speak voice="Lars"/>', '<speak>Hej', '</speak>',
    '<speak><swedish>Hej</speak></swedish>', '<speak speed="2">Hej</speak>',
])
def test_invalid_controls_report_error(source):
    with pytest.raises(ValueError):
        narration_chunks(source)


def test_code_example_does_not_switch_voice():
    parts = narration_chunks('`<speak voice="Lars">` means a scope.\n\n```xml\n<speak>\n```\n\nHello.')
    assert all(p.voice is None and p.language == 'en' for p in parts)


def test_cli_forwards_options_and_reports_malformed_scope(monkeypatch):
    calls = []
    monkeypatch.setattr(cli.player, 'start', lambda lines, pause: calls.append(lines))
    mode = cli.VoiceMode(voice='af_heart', enabled=True)
    assert mode.narrate('<speak voice="Lars" speed="0.9">Hej</speak>') is None
    assert calls[0][0]['voice'] == 'Lars'
    assert calls[0][0]['speed'] == .9
    assert mode.narrate('<speak>Hej') is not None
    assert len(calls) == 1


def test_swedish_routing_and_explicit_engine():
    assert tts.line_engine({'voice': 'Lars'}) == 'kokoro-sv'
    assert tts.line_engine({'language': 'sv'}) == 'kokoro-sv'
    assert tts.line_engine({'voice': 'Alva', 'language': 'sv', 'engine': 'say'}) == 'say'


def test_swedish_context_split_keeps_all_text_and_adds_no_silence(monkeypatch):
    calls = []
    def synthesize(text, **kwargs):
        calls.append((text, kwargs))
        assert len(text) <= 510
        return np.ones(3, dtype=np.float32)
    model = SimpleNamespace(g2p=lambda text: text, model=SimpleNamespace(vocab={c: 1 for c in 'Hej. \n'}), synthesize=synthesize)
    monkeypatch.setattr(tts, '_swedish_model', lambda: model)
    source = 'Hej. ' * 200
    result = tts.swedish_render(source, 'Lars', .9)
    assert ''.join(text for text, _ in calls) == source
    assert all(opts == {'voice': 'Lars', 'speed': .9} for _, opts in calls)
    assert len(result) == 3 * len(calls)
