import { createParser } from "eventsource-parser";
import { z } from "zod";

// Provider-owned request types. Chat maps its records into these.
export type AudioPayload = { data: string; format: string };
export type PhotoPayload = { data: string };
export type ProviderMessage = {
  role: "user" | "assistant";
  text: string;
  audio?: AudioPayload;
  photos?: PhotoPayload[];
};
export type ReplyRequest = { apiKey: string; model: string };
// `sessionId` keeps one conversation's requests together, so OpenRouter
// routes them to one provider and its prompt cache can be reused.
export type SessionRequest = ReplyRequest & { sessionId: string };
// What a reply reports about itself; each is null when it went unreported.
// Cached tokens are prompt tokens read from the provider's prompt cache.
export type Usage = {
  costUSD: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  cacheWritePromptTokens: number | null;
};
// `stopped` is why a reply ended before the model finished it: the output
// limit was reached, or a time limit below ran out. The text so far is kept.
export type Completion = {
  text: string;
  model: string;
  usage: Usage;
  stopped: "length" | "timeout" | null;
};
export type StreamReply = (
  messages: ProviderMessage[],
  request: SessionRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<Completion>;

// A reply may think or pause this long between stream events, and take this
// long in all. Keep-alive comments are not events.
const SILENCE_LIMIT_MILLIS = 120_000;
const REPLY_LIMIT_MILLIS = 600_000;

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
// Photos are limited per message: this many, and this many bytes together.
export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
// The base64 characters that many bytes encode to. Limits are in bytes;
// stored and sent media is base64 text.
export const encodedLength = (bytes: number) => Math.ceil(bytes / 3) * 4;
// A byte limit as people read it, such as "8 MB".
export const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

export function validateAudioPayload(audio: AudioPayload) {
  if (!AUDIO_FORMATS.includes(audio.format))
    throw new Error(
      "Choose an M4A, MP3, WAV, AAC, OGG, FLAC, AIFF, or WebM audio file.",
    );
  if (!audio.data || audio.data.length > encodedLength(MAX_AUDIO_BYTES))
    throw new Error(
      `Audio must be nonempty and under ${megabytes(MAX_AUDIO_BYTES)}.`,
    );
}

export function validatePhotoPayloads(photos: PhotoPayload[]) {
  if (!photos.length || photos.length > MAX_PHOTOS)
    throw new Error(`Choose between 1 and ${MAX_PHOTOS} photos.`);
  let bytes = 0;
  for (const photo of photos) {
    if (!photo.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data))
      throw new Error("Couldn’t read that photo. Choose it again.");
    bytes += Math.ceil((photo.data.length * 3) / 4);
  }
  if (bytes > MAX_PHOTO_BYTES)
    throw new Error(
      `Keep photos under ${megabytes(MAX_PHOTO_BYTES)} per message.`,
    );
}

// Encode an already bounded context; selection belongs to the caller.
export function requestMessages(messages: ProviderMessage[]) {
  const result: {
    role: "user" | "assistant";
    content:
      | string
      | (
          | { type: "text"; text: string }
          | { type: "input_audio"; input_audio: AudioPayload }
          | { type: "image_url"; image_url: { url: string } }
        )[];
  }[] = [];
  for (const message of messages) {
    if (message.photos?.length) {
      validatePhotoPayloads(message.photos);
      result.push({
        role: message.role,
        content: [
          ...(message.text
            ? [{ type: "text" as const, text: message.text }]
            : []),
          ...message.photos.map((photo) => ({
            type: "image_url" as const,
            image_url: { url: `data:image/jpeg;base64,${photo.data}` },
          })),
        ],
      });
    } else if (message.audio) {
      validateAudioPayload(message.audio);
      const { data, format } = message.audio;
      result.push({
        role: "user",
        content: [{ type: "input_audio", input_audio: { data, format } }],
      });
    } else result.push({ role: message.role, content: message.text });
  }
  return result;
}

// Optional fields that are absent or malformed are ignored.
const optional = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);
const providerErrorBody = z.object({
  error: z
    .object({
      message: optional(z.string()),
      code: optional(z.number()),
      metadata: optional(z.object({ raw: optional(z.string()) })),
    })
    .optional()
    .catch(undefined),
});
const nestedError = z.union([
  z.object({ error: z.object({ message: z.string() }) }),
  z.object({ message: z.string() }),
]);
const firstChoice = z.object({
  delta: optional(z.object({ content: optional(z.string()) })),
  finish_reason: optional(z.string()),
});
const streamEvent = z.object({
  // Any object or array under `error` ends the stream as a provider error.
  error: optional(
    z.union([
      z.object({ code: optional(z.number()) }),
      z.array(z.unknown()).transform(() => ({ code: undefined })),
    ]),
  ),
  model: optional(z.string()),
  usage: optional(
    z.object({
      cost: optional(z.number()),
      prompt_tokens: optional(z.number()),
      completion_tokens: optional(z.number()),
      prompt_tokens_details: optional(
        z.object({
          cached_tokens: optional(z.number()),
          cache_write_tokens: optional(z.number()),
        }),
      ),
    }),
  ),
  choices: optional(
    z.array(z.unknown()).transform((choices) => {
      const parsed = firstChoice.safeParse(choices[0]);
      return parsed.success
        ? {
            content: parsed.data.delta?.content,
            finish: parsed.data.finish_reason,
          }
        : undefined;
    }),
  ),
});

function httpError(status: number) {
  if (status === 401 || status === 403)
    return "OpenRouter rejected the key. Check it in Settings.";
  if (status === 402)
    return "OpenRouter reports insufficient credits for this model.";
  if (status === 429) return "The request was rate limited. Try again later.";
  if (status === 503)
    return "No provider is available for this model right now. Try again later.";
  return `OpenRouter request failed (HTTP ${status}).`;
}

function providerError(status: number, body: unknown, apiKey: string) {
  const details: string[] = [];
  const parsed = providerErrorBody.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  if (error?.message) details.push(error.message);
  if (error?.metadata?.raw) {
    try {
      const raw = nestedError.safeParse(JSON.parse(error.metadata.raw));
      if (raw.success)
        details.push(
          "error" in raw.data ? raw.data.error.message : raw.data.message,
        );
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
  return new Error(`${httpError(status)}${detail ? ` ${detail}` : ""}`);
}

export async function completeReply(
  messages: ProviderMessage[],
  settings: SessionRequest & { maxTokens: number },
  signal: AbortSignal,
  onText: (text: string) => void,
  fetcher: typeof fetch,
): Promise<Completion> {
  const context = requestMessages(messages);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    controller.abort();
  };
  const ceiling = setTimeout(expire, REPLY_LIMIT_MILLIS);
  let silence = setTimeout(expire, SILENCE_LIMIT_MILLIS);
  let text = "";
  let model = settings.model;
  const usage: Usage = {
    costUSD: null,
    promptTokens: null,
    completionTokens: null,
    cachedPromptTokens: null,
    cacheWritePromptTokens: null,
  };
  // The latest reported value of each counts; others keep theirs.
  const report = (field: keyof Usage, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) usage[field] = value;
  };
  // A rejected request or body read is the connection failing, whatever the
  // platform calls it. An abort is our own and passes through.
  const unreachable = (cause: unknown): never => {
    if (controller.signal.aborted) throw cause;
    throw new Error(
      "Couldn’t reach OpenRouter. Check your connection and retry.",
      { cause },
    );
  };
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
          session_id: settings.sessionId,
          messages: context,
          max_tokens: settings.maxTokens,
          stream: true,
          reasoning:
            settings.model === AUDIO_MODEL
              ? { effort: "low" }
              : { enabled: false },
        }),
      },
    ).catch(unreachable);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw providerError(response.status, body, settings.apiKey);
    }
    if (!response.body)
      throw new Error("OpenRouter returned no response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finished = false;
    let truncated = false;
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
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          throw new Error("OpenRouter returned an invalid response stream.");
        }
        const parsed = streamEvent.safeParse(json);
        if (!parsed.success)
          throw new Error("OpenRouter returned an invalid response stream.");
        clearTimeout(silence);
        silence = setTimeout(expire, SILENCE_LIMIT_MILLIS);
        const data = parsed.data;
        if (data.error)
          throw providerError(data.error.code ?? 502, json, settings.apiKey);
        if (data.model !== undefined) model = data.model;
        if (data.usage) {
          const details = data.usage.prompt_tokens_details;
          report("costUSD", data.usage.cost);
          report("promptTokens", data.usage.prompt_tokens);
          report("completionTokens", data.usage.completion_tokens);
          report("cachedPromptTokens", details?.cached_tokens);
          report("cacheWritePromptTokens", details?.cache_write_tokens);
        }
        if (data.choices?.finish === "length") truncated = true;
        if (data.choices?.content) {
          text += data.choices.content;
          onText(text);
        }
      },
    });
    try {
      while (!finished) {
        const chunk = await reader.read().catch(unreachable);
        if (controller.signal.aborted) throw new Error("Reply cancelled.");
        if (chunk.done) {
          parser.feed(decoder.decode());
          break;
        }
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
      if (!finished) throw new Error("The response stream ended early.");
      if (truncated) return { text, model, usage, stopped: "length" };
      if (!text.trim()) throw new Error("The model returned no text.");
      return { text, model, usage, stopped: null };
    } finally {
      // Cancel unread bytes on Stop, parser errors, or after the terminal frame.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (cause) {
    if (timedOut && !signal.aborted)
      return { text, model, usage, stopped: "timeout" };
    throw cause;
  } finally {
    clearTimeout(ceiling);
    clearTimeout(silence);
    signal.removeEventListener("abort", abort);
  }
}
