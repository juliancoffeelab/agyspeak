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


def test_leaves_currency_and_normal_markdown_unchanged() -> None:
    source = "That costs $5. **Still cheap.**"

    assert for_terminal(source) == source


def test_converts_bracketed_and_parenthesized_latex() -> None:
    source = r"The result is \(x \geq 2\). \[x \rightarrow \infty\]"

    rendered = for_terminal(source)

    assert "The result is x ≥ 2." in rendered
    assert "x → ∞" in rendered
