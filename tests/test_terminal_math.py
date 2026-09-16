from agyspeak.terminal_math import for_terminal


def test_converts_display_math_to_terminal_text() -> None:
    source = (
        "Before\n\n"
        r"$$\text{Lips Pucker (W)} \longrightarrow "
        r"\text{Front Floor (EE)} \longrightarrow \text{Roof Tap (D)}$$"
        "\n\nAfter"
    )

    rendered = for_terminal(source)

    assert "$$" not in rendered
    assert "\\text" not in rendered
    assert "Lips Pucker (W) → Front Floor (EE) → Roof Tap (D)" in rendered


def test_converts_common_math_constructs() -> None:
    rendered = for_terminal(r"$$\frac{a}{b} \approx \sqrt{x} \times \pi$$")

    assert rendered.strip() == "a/b ≈ √(x) × π"


def test_normalizes_styled_math_letters_that_break_terminal_spacing() -> None:
    rendered = for_terminal(r"$$\mathbf{/wɪərd/} = \mathbf{[fiːəl]}$$")

    assert rendered.strip() == "/wɪərd/ = [fiːəl]"


def test_leaves_currency_and_normal_markdown_unchanged() -> None:
    source = "That costs $5. From $5 to $10. **Still cheap.**"

    assert for_terminal(source) == source


def test_converts_inline_dollar_math() -> None:
    source = r"Energy is $E = mc^2$; sound is $F_1 = 300\text{ Hz}$."

    rendered = for_terminal(source)

    assert rendered == "Energy is E = mc^2; sound is F_1 = 300 Hz."


def test_converts_bracketed_and_parenthesized_latex() -> None:
    source = r"The result is \(x \geq 2\). \[x \rightarrow \infty\]"

    rendered = for_terminal(source)

    assert "The result is x ≥ 2." in rendered
    assert "x → ∞" in rendered


def test_ignores_math_delimiters_inside_markdown_code() -> None:
    source = (
        "Inline (`$...$`) vs block (`$$...$$`); look for `$$`.\n\n"
        r"$$F_1 = 300 \text{ Hz}$$" "\n"
        r"$$\text{Pitch} = \frac{1}{\text{Period}}$$" "\n"
        r"$$\alpha + \beta = \gamma$$"
    )

    rendered = for_terminal(source)

    assert "(`$$...$$`)" in rendered
    assert "`$$`" in rendered
    assert "F_1 = 300 Hz" in rendered
    assert "Pitch = 1/Period" in rendered
    assert "α+ β = γ" in rendered
    assert r"\text" not in rendered
