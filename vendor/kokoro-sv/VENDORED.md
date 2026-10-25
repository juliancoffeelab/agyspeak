# Vendored Swedish Kokoro

Source: https://github.com/joakimeriksson/kokoro-sv

Upstream commit: `008429bf32971ea2818ff6cc0fc9d89af8c5f350`

Upstream package version: `0.1.3`

License: Apache-2.0; upstream license and attribution are retained in `LICENSE`
and `README_pypi.md`.

This copy contains the runtime package and local regression tests. Training code,
datasets, model weights, generated audio, and the upstream Git repository are
excluded. Model weights and the Swedish pronunciation lexicon download from
Hugging Face into its normal cache on first use.

## Local changes

- Preserve em dashes and ellipses through the neural pronunciation tokenizer.
- Add `SwedishG2P(..., preserve_line_breaks=True)`: encode otherwise unpunctuated
  line endings as commas and paragraph boundaries as periods. Existing
  punctuation takes precedence. This supplies model cues without adding audio
  silence; ordinary prose behavior stays unchanged when the option is off.
- Add regression tests for punctuation, layout cues, and the default prose mode.

uv installs this directory as an editable dependency through the root
`pyproject.toml`, so edits here are used directly.

Run the focused checks from the AGSpeak root:

```sh
uv run python -m unittest discover -s vendor/kokoro-sv/tests
```
