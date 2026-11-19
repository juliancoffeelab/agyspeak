// Chat records shared by storage, the controller and the UI. Storage maps SQL
// rows into these; nothing here knows about SQL or providers.
// The named chat is not saved: it was deleted, or never existed.
export class MissingChatError extends Error {
  name = "MissingChatError";
  constructor() {
    super("Chat no longer exists.");
  }
}
export type ReplyStatus = "complete" | "pending" | "failed" | "cancelled";
export type AudioMetadata = {
  format: string;
  durationMillis?: number;
  levels?: number[];
};
// The most characters one typed message, sent or still a draft, may have.
export const MAX_MESSAGE_LENGTH = 12_000;

export type AudioInput = AudioMetadata & { data: string };
// What a person sends in one turn: words with any photos, or a recording.
export type Turn =
  | { kind: "text"; text: string; photos: PhotoInput[] }
  | { kind: "audio"; audio: AudioInput };
export type AudioAttachment = AudioMetadata & {
  id: number;
  encodedLength: number;
};
export type PhotoReference = { id: number; draft: boolean };
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
export type Message = {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: ReplyStatus;
  replyTo: number | null;
  error: string | null;
  model: string | null;
  elapsedMillis: number | null;
  // Present only on a message that has one.
  audio?: AudioAttachment;
  photos?: PhotoAttachment[];
};
export type PromptMessage = Omit<Message, "audio" | "photos"> & {
  audio?: AudioInput;
  photos?: PhotoInput[];
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
export type ChatHistory = {
  // Null until the chats are first read.
  chats: ChatSummary[] | null;
  activeId: string;
  messages: Message[];
  selectedModel: string | null;
};
