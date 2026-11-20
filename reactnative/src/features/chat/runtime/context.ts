import type { PromptMessage } from "../storage/contracts";
import type { ProviderMessage } from "../../../providers/openrouter/transport";

// What selection reads of a message: sizes, never the bytes themselves.
export type ContextEntry = {
  role: "user" | "assistant";
  text: string;
  status: string;
  audio?: { encodedLength?: number; data?: string };
  photos?: { encodedLength?: number; data?: string }[];
};

// Select context using metadata before reading any recording bytes: the
// newest messages, as many as the budgets allow. The text budget is soft at
// the message that crosses it, which is included whole and ends the walk, so
// one long message never empties the context. The media budget is hard.
export function selectContext<T extends ContextEntry>(messages: T[]): T[] {
  const selected: T[] = [];
  let textRemaining = 24_000;
  let mediaRemaining = 12 * 1024 * 1024;
  for (const message of [...messages].reverse()) {
    // A stopped reply's partial text is part of what was said; a failed one
    // may be cut off by its error.
    if (
      message.role === "assistant" &&
      message.status !== "complete" &&
      message.status !== "cancelled"
    )
      continue;
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
      textRemaining -= message.text.length;
    }
    selected.unshift(message);
    if (textRemaining <= 0) break;
  }
  return selected;
}

// A recording's levels reduced to at most the bars a message shows.
export function summarizeLevels(levels: number[]): number[] {
  const count = Math.min(32, levels.length);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * levels.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * levels.length) / count),
    );
    return Math.max(...levels.slice(start, end));
  });
}

// Map stored conversation data into the provider's independent request type.
export function toProviderContext(
  messages: PromptMessage[],
): ProviderMessage[] {
  return selectContext(messages).map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.audio
      ? { audio: { data: message.audio.data, format: message.audio.format } }
      : {}),
    ...(message.photos?.length
      ? { photos: message.photos.map((photo) => ({ data: photo.data })) }
      : {}),
  }));
}
