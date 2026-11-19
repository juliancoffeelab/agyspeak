import { z } from "zod";

const keyPayload = z.object({
  type: z.literal("agyspeak.openrouter-key"),
  version: z.literal(1),
  key: z.string(),
});

// Accepts a bare key, a Bearer header value, or the AGSpeak key QR payload.
export function parseKeyInput(input: string): string {
  let value = input.trim();
  if (value.startsWith("{")) {
    const payload = keyPayload.safeParse(JSON.parse(value));
    if (!payload.success)
      throw new Error(
        "This QR code does not contain an AGSpeak OpenRouter key.",
      );
    value = payload.data.key.trim();
  }
  value = value.replace(/^Bearer\s+/i, "");
  if (!/^sk-or-[A-Za-z0-9_-]{16,2048}$/.test(value))
    throw new Error("That does not look like an OpenRouter API key.");
  return value;
}
