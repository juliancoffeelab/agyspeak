from pathlib import Path

import numpy as np
import soundfile as sf

from agyspeak import audio


def test_split_wav_preserves_every_sample_and_original(monkeypatch, tmp_path: Path):
    wav = tmp_path / 'recording with spaces.wav'
    samples = np.arange(48001, dtype=np.int16)
    sf.write(wav, samples, 8000, subtype='PCM_16')
    original = wav.read_bytes()
    monkeypatch.setattr(audio, 'MODEL_AUDIO_SECONDS', 2)
    parts = audio.prepare_for_model(wav)
    assert len(parts) == 4
    assert [sf.info(p).frames for p in parts] == [16000, 16000, 16000, 1]
    joined = np.concatenate([sf.read(p, dtype='int16')[0] for p in parts])
    np.testing.assert_array_equal(joined, samples)
    assert wav.read_bytes() == original
    monkeypatch.setattr(audio.sf, 'write', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('cache regenerated')))
    assert audio.prepare_for_model(wav) == parts


def test_short_wav_uses_original(tmp_path: Path):
    wav = tmp_path / 'clip.wav'
    sf.write(wav, np.zeros(160), 16000, subtype='PCM_16')
    assert audio.prepare_for_model(wav) == [wav]
