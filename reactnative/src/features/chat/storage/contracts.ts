// Chat records shared by storage, the runtime and the UI. Storage maps SQL
// rows into these; nothing here knows about SQL or providers.
// The named chat is not saved: it was deleted, or never existed.
export class MissingChatError extends Error {
  name = "MissingChatError";
  constructor() {
    super("Chat no longer exists.");
  }
}
export type AudioMetadata = {
  format: string;
  durationMillis?: number;
  levels?: number[];
};
export type AudioInput = AudioMetadata & { data: string };
// A photo to show whole: one of the draft, by id, or of a message, by its
// media key.
export type PhotoReference =
  | { draft: true; id: number }
  | { draft: false; key: string; width: number; height: number };
export type PhotoInput = {
  data: string;
  thumbnail: string;
  width: number;
  height: number;
};
export type PhotoAttachment = Omit<PhotoInput, "data"> & {
  id: number;
  encodedLength: number;
};
// What a chat's unsent draft holds; null when it holds nothing.
export type DraftSummary = { text: string; photos: number } | null;
export function summarizeDraft(text: string, photos: number): DraftSummary {
  return text.trim() !== "" || photos > 0 ? { text, photos } : null;
}
// A chat as History lists it. `title` is null until its first message saves
// it: that chat is the new chat.
export type ChatSummary = {
  id: string;
  title: string | null;
  updatedAt: number;
  preview: string;
  draft: DraftSummary;
};
