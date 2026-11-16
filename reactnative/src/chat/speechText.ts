import MarkdownParser, { type Token } from "markdown-it";

const markdown = new MarkdownParser({ html: true, linkify: false });
function words(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (
        token.type === "fence" ||
        token.type === "code_block" ||
        token.type === "html_block" ||
        token.type === "html_inline"
      )
        return "";
      if (token.children) return words(token.children);
      if (token.type === "text" || token.type === "code_inline")
        return token.content;
      if (token.type === "softbreak" || token.type === "hardbreak") return " ";
      if (
        [
          "paragraph_close",
          "heading_close",
          "list_item_close",
          "tr_close",
        ].includes(token.type)
      )
        return "\n";
      if (token.type === "td_close" || token.type === "th_close") return " ";
      return "";
    })
    .join("");
}
export function speechText(text: string): string {
  return words(markdown.parse(text, {}))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function speechChunks(text: string, maxLength: number): string[] {
  const limit = Math.max(1, Math.floor(Math.min(maxLength, 3000)));
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const boundary = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" "),
    );
    let end = boundary > limit / 2 ? boundary + 1 : limit;
    // Never split a UTF-16 surrogate pair when there is room for a full code point.
    if (
      end > 1 &&
      /[\uD800-\uDBFF]/.test(remaining[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(remaining[end])
    )
      end--;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
