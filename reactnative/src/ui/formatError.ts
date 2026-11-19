// The full failure for a bug report: every error in the cause chain with its
// stack. Messages are the errors' own; callers keep credentials out of them.
export function formatError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (!seen.has(current)) {
    seen.add(current);
    const prefix = parts.length ? "Caused by: " : "";
    if (!(current instanceof Error)) {
      parts.push(prefix + String(current));
      break;
    }
    const { code } = current as { code?: unknown };
    const tag =
      typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
    const heading = `${current.name}${tag}: ${current.message}`;
    const frames = current.stack
      ?.split("\n")
      .filter((line) => /^\s+at\s/.test(line))
      .join("\n");
    parts.push(prefix + heading + (frames ? `\n${frames}` : ""));
    if (current.cause === undefined) break;
    current = current.cause;
  }
  return parts.join("\n");
}
