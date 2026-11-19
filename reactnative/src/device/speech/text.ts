export function speechChunks(prose: string, maxLength: number): string[] {
  const limit = Math.max(1, Math.floor(Math.min(maxLength, 3000)));
  const chunks: string[] = [];
  let remaining = prose.trim();
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
