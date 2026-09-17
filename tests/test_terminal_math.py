from rich.console import Console

from agyspeak.terminal_math import TerminalMarkdown


def render(source: str) -> str:
    console = Console(record=True, width=120, color_system=None)
    console.print(TerminalMarkdown(source))
    return console.export_text()


def test_converts_display_math_to_terminal_text() -> None:
    source = (
        "Before\n\n"
        r"$$\text{Lips Pucker (W)} \longrightarrow "
        r"\text{Front Floor (EE)} \longrightarrow \text{Roof Tap (D)}$$"
        "\n\nAfter"
    )

    rendered = render(source)

    assert "$$" not in rendered
    assert "\\text" not in rendered
    assert "Lips Pucker (W) → Front Floor (EE) → Roof Tap (D)" in rendered


def test_converts_common_math_constructs() -> None:
    rendered = render(r"$$\frac{a}{b} \approx \sqrt{x} \times \pi$$")

    assert rendered.strip() == "a/b ≈ √(x) × π"


def test_normalizes_styled_math_letters_that_break_terminal_spacing() -> None:
    rendered = render(r"$$\mathbf{/wɪərd/} = \mathbf{[fiːəl]}$$")

    assert rendered.strip() == "/wɪərd/ = [fiːəl]"


def test_leaves_currency_and_renders_normal_markdown() -> None:
    rendered = render("That costs $5. From $5 to $10. **Still cheap.**")

    assert rendered.strip() == "That costs $5. From $5 to $10. Still cheap."


def test_converts_inline_dollar_math() -> None:
    rendered = render(r"Energy is $E = mc^2$; sound is $F_1 = 300\text{ Hz}$.")

    assert rendered.strip() == "Energy is E = mc^2; sound is F_1 = 300 Hz."


def test_converts_bracketed_and_parenthesized_latex() -> None:
    source = "The result is " + r"\(x \geq 2\)." + "\n\n" + r"\[x \rightarrow \infty\]"

    rendered = render(source)

    assert "The result is x ≥ 2." in rendered
    assert "x → ∞" in rendered


def test_math_delimiters_inside_markdown_code_are_not_parsed() -> None:
    source = (
        "Inline (`$...$`) vs block (`$$...$$`); look for `$$`.\n\n"
        r"$$F_1 = 300 \text{ Hz}$$" "\n"
        r"$$\text{Pitch} = \frac{1}{\text{Period}}$$" "\n"
        r"$$\alpha + \beta = \gamma$$"
    )

    rendered = render(source)

    assert "$...$" in rendered
    assert "$$...$$" in rendered
    assert "$$" in rendered
    assert "F_1 = 300 Hz" in rendered
    assert "Pitch = 1/Period" in rendered
    assert "α+ β = γ" in rendered
    assert r"\text" not in rendered
