import { createParser } from "eventsource-parser";
import type { AudioInput, PromptMessage } from "./history";
import { selectContext } from "./context.ts";

export const AUDIO_MODEL = "google/gemini-3.8-flash";
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const AUDIO_FORMATS = [
  "m4a",
  "mp3",
  "wav",
  "aac",
  "ogg",
  "flac",
  "aiff",
  "webm",
];

export function validateAudio(audio: AudioInput) {
  if (!AUDIO_FORMATS.includes(audio.format))
    throw new Error(
      "Choose an M4A, MP3, WAV, AAC, OGG, FLAC, AIFF, or WebM audio file.",
    );
  if (!audio.data || audio.data.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4)
    throw new Error("Audio must be nonempty and under 8 MB.");
}

export type ModelSettings = { apiKey: string; model: string };
export type Completion = { text: string; model: string; cost: number | null };
export type ReplyFunction = (
  messages: PromptMessage[],
  settings: ModelSettings,
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<Completion>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Bound what we send, independently of how much history is loaded for reading.
export function requestMessages(messages: PromptMessage[]) {
  const result: {
    role: "user" | "assistant";
    content:
      | string
      | (
          | { type: "text"; text: string }
          | { type: "input_audio"; input_audio: AudioInput }
        )[];
  }[] = [];
  for (const message of selectContext(messages)) {
    if (message.audio) {
      validateAudio(message.audio);
      const { data, format } = message.audio;
      result.push({
        role: "user",
        content: [{ type: "input_audio", input_audio: { data, format } }],
      });
    } else result.push({ role: message.role, content: message.text });
  }
  return result;
}

function httpError(status: number, detail = "") {
  if (status === 401 || status === 403)
    return "OpenRouter rejected the key. Check it in Settings.";
  if (status === 402)
    return "OpenRouter reports insufficient credits for this model.";
  if (status === 429) {
    const source = /upstream|provider|temporarily rate-limited/i.test(detail)
      ? "The model provider is rate limited."
      : "The request was rate limited.";
    return `${source} Try again later.`;
  }
  if (status === 503)
    return "No provider is available for this model right now. Try again later.";
  return `OpenRouter request failed (HTTP ${status}).`;
}

function providerError(status: number, body: unknown, apiKey: string) {
  const details: string[] = [];
  const error = record(body) && record(body.error) ? body.error : null;
  if (error && typeof error.message === "string") details.push(error.message);
  if (
    error &&
    record(error.metadata) &&
    typeof error.metadata.raw === "string"
  ) {
    try {
      const raw: unknown = JSON.parse(error.metadata.raw);
      const nested = record(raw) && record(raw.error) ? raw.error : raw;
      if (record(nested) && typeof nested.message === "string")
        details.push(nested.message);
    } catch {
      /* Keep the public message; never display an arbitrary raw body. */
    }
  }
  const detail = [...new Set(details)]
    .join(" ")
    .replaceAll(apiKey, "[redacted]")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 400);
  return new Error(`${httpError(status, detail)}${detail ? ` ${detail}` : ""}`);
}

export async function completeReply(
  messages: PromptMessage[],
  settings: ModelSettings,
  signal: AbortSignal,
  onText: (text: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<Completion> {
  const context = requestMessages(messages);
  const audioTurn = context.some((message) => Array.isArray(message.content));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetcher(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "AGSpeak",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: settings.model,
          messages: context,
          max_tokens: audioTurn ? 1024 : 512,
          stream: true,
          reasoning:
            settings.model === AUDIO_MODEL
              ? { effort: "low" }
              : { enabled: false },
        }),
      },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw providerError(response.status, body, settings.apiKey);
    }
    if (!response.body)
      throw new Error("OpenRouter returned no response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let model = settings.model;
    let cost: number | null = null;
    let finished = false;
    const parser = createParser({
      maxBufferSize: 1_048_576,
      onError() {
        throw new Error("OpenRouter returned an invalid response stream.");
      },
      onEvent(event) {
        if (finished || controller.signal.aborted) return;
        if (event.data === "[DONE]") {
          finished = true;
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new Error("OpenRouter returned an invalid response stream.");
        }
        if (!record(data))
          throw new Error("OpenRouter returned an invalid response stream.");
        if (record(data.error))
          throw providerError(
            typeof data.error.code === "number" ? data.error.code : 502,
            data,
            settings.apiKey,
          );
        if (typeof data.model === "string") model = data.model;
        if (
          record(data.usage) &&
          typeof data.usage.cost === "number" &&
          Number.isFinite(data.usage.cost)
        )
          cost = data.usage.cost;
        const choice: unknown = Array.isArray(data.choices)
          ? data.choices[0]
          : undefined;
        const delta =
          record(choice) && record(choice.delta) ? choice.delta : null;
        if (delta && typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onText(text);
        }
      },
    });
    try {
      while (!finished) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error("Reply cancelled.");
        if (chunk.done) {
          parser.feed(decoder.decode());
          break;
        }
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
      if (!finished)
        throw new Error("The response stream ended early. You can retry it.");
      if (!text.trim())
        throw new Error(
          "The model returned no text. You can retry or choose another model.",
        );
      return { text, model, cost };
    } finally {
      // Cancel unread bytes on Stop, parser errors, or after the terminal frame.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted)
      throw new Error("The request timed out. You can retry it.", { cause });
    if (
      cause instanceof Error &&
      cause.message.startsWith("Network request failed")
    )
      throw new Error(
        "Couldn’t reach OpenRouter. Check your connection and retry.",
        { cause },
      );
    throw cause;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
