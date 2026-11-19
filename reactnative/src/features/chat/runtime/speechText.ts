import MarkdownParser, { type Token } from "markdown-it";

const markdownParser = new MarkdownParser({ html: true, linkify: false });
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
// What of a response is read aloud: its prose, without Markdown syntax,
// code blocks or HTML.
export function markdownToSpeechText(markdown: string): string {
  return words(markdownParser.parse(markdown, {}))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
