type Entry = {
  role: "user" | "assistant";
  text: string;
  status: string;
  audio?: { encodedLength?: number; data?: string } | null;
  photos?: { encodedLength?: number; data?: string }[];
};

// Select context using metadata before reading any recording bytes.
export function selectContext<T extends Entry>(messages: T[]): T[] {
  const selected: T[] = [];
  let textRemaining = 24_000;
  let mediaRemaining = 12 * 1024 * 1024;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && message.status !== "complete") continue;
    if (message.audio) {
      const encodedLength =
        message.audio.encodedLength ?? message.audio.data?.length ?? 0;
      const bytes = Math.ceil((encodedLength * 3) / 4);
      if (bytes > mediaRemaining) break;
      mediaRemaining -= bytes;
    }
    const photoBytes = (message.photos ?? []).reduce(
      (sum, photo) =>
        sum +
        Math.ceil(((photo.encodedLength ?? photo.data?.length ?? 0) * 3) / 4),
      0,
    );
    if (photoBytes > mediaRemaining) break;
    mediaRemaining -= photoBytes;
    if (!message.audio) {
      if (!message.text && !message.photos?.length) continue;
      if (message.text.length > textRemaining) break;
      textRemaining -= message.text.length;
    }
    selected.unshift(message);
  }
  return selected;
}

// Match selection after adding the prospective outgoing text and photos.
function withDraft(
  messages: Entry[],
  nextText: string,
  photos: NonNullable<Entry["photos"]> = [],
): Entry[] {
  const text = nextText.trim();
  return text || photos.length
    ? [...messages, { role: "user", text, photos, status: "complete" }]
    : messages;
}
export function contextHasAudio(
  messages: Entry[],
  nextText: string,
  photos: NonNullable<Entry["photos"]> = [],
): boolean {
  return selectContext(withDraft(messages, nextText, photos)).some((message) =>
    Boolean(message.audio),
  );
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

export function contextHasPhotos(
  messages: Entry[],
  nextText: string,
  photos: NonNullable<Entry["photos"]> = [],
): boolean {
  return selectContext(withDraft(messages, nextText, photos)).some((message) =>
    Boolean(message.photos?.length),
  );
}
