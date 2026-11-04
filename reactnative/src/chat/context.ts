type Entry = {
  role: "user" | "assistant";
  text: string;
  status: string;
  audio?: { encodedLength?: number; data?: string } | null;
};

// Select context using metadata before reading any recording bytes.
export function selectContext<T extends Entry>(messages: T[]): T[] {
  const selected: T[] = [];
  let textRemaining = 24_000;
  let audioRemaining = 12 * 1024 * 1024;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && message.status !== "complete") continue;
    if (message.audio) {
      const encodedLength =
        message.audio.encodedLength ?? message.audio.data?.length ?? 0;
      const bytes = Math.ceil((encodedLength * 3) / 4);
      if (bytes > audioRemaining) break;
      audioRemaining -= bytes;
    } else {
      if (!message.text) continue;
      if (message.text.length > textRemaining) break;
      textRemaining -= message.text.length;
    }
    selected.unshift(message);
  }
  return selected;
}

export function summarizeLevels(levels: number[], limit = 32): number[] {
  const count = Math.min(limit, levels.length);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * levels.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * levels.length) / count),
    );
    return Math.max(...levels.slice(start, end));
  });
}
