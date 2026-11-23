import {
  requestMessages,
  type ProviderMessage,
} from "../../../providers/openrouter/transport.ts";

// The messages of a request body, as `requestMessages` encodes them.
export type WireMessage = ReturnType<typeof requestMessages>[number];

// A request as the request view shows it: each body message with its role
// as sent, and its content parts in order. Text is the body's own string,
// untouched; media is shown by what it is and its size, not its bytes.
export type ShownPart =
  | { kind: "text"; text: string }
  | { kind: "photo"; url: string; bytes: number }
  | { kind: "recording"; format: string; bytes: number };
export type ShownMessage = { role: WireMessage["role"]; parts: ShownPart[] };

// Decoded bytes of base64 text, padded or not.
function decodedBytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// What a request sends, from the same messages and encoder the request uses.
export function shownRequest(messages: ProviderMessage[]): ShownMessage[] {
  return requestMessages(messages).map((message) => ({
    role: message.role,
    parts:
      typeof message.content === "string"
        ? [{ kind: "text", text: message.content }]
        : message.content.map((part): ShownPart => {
            if (part.type === "text") return { kind: "text", text: part.text };
            if (part.type === "image_url")
              return {
                kind: "photo",
                url: part.image_url.url,
                bytes: decodedBytes(part.image_url.url.split(",")[1] ?? ""),
              };
            return {
              kind: "recording",
              format: part.input_audio.format,
              bytes: decodedBytes(part.input_audio.data),
            };
          }),
  }));
}

// The whole request as one text to copy: the body's `messages` as JSON,
// where every string is exactly what is sent and only media bytes are
// replaced by what they are. `JSON.parse` gives the strings back unchanged.
export function requestTranscript(shown: ShownMessage[]): string {
  return JSON.stringify(
    shown.map(({ role, parts }) => ({
      role,
      content: parts.map((part) =>
        part.kind === "text"
          ? { type: "text", text: part.text }
          : part.kind === "photo"
            ? { type: "image", bytes: part.bytes }
            : { type: "audio", format: part.format, bytes: part.bytes },
      ),
    })),
    null,
    2,
  );
}
