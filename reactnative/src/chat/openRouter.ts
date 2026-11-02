import type { Message } from './history';

export type ModelSettings = { apiKey: string; model: string };
export type Completion = { text: string; model: string; cost: number | null };
export type ReplyFunction = (messages: Message[], settings: ModelSettings, signal: AbortSignal) => Promise<Completion>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Bound what we send, independently of how much history is loaded for reading.
export function requestMessages(messages: Message[]) {
  const result: { role: 'user' | 'assistant'; content: string }[] = [];
  let remaining = 24_000;
  for (const message of [...messages].reverse()) {
    if (message.role === 'assistant' && message.status !== 'complete') continue;
    if (!message.text) continue;
    if (message.text.length > remaining) break;
    result.unshift({ role: message.role, content: message.text });
    remaining -= message.text.length;
  }
  return result;
}

function httpError(status: number, detail = '') {
  if (status === 401 || status === 403) return 'OpenRouter rejected the key. Check it in Settings.';
  if (status === 402) return 'OpenRouter reports insufficient credits for this model.';
  if (status === 429) {
    const source = /upstream|provider|temporarily rate-limited/i.test(detail) ? 'The model provider is rate limited.' : 'The request was rate limited.';
    return `${source} Try again later.`;
  }
  if (status === 503) return 'No provider is available for this model right now. Try again later.';
  return `OpenRouter request failed (HTTP ${status}).`;
}

function providerError(status: number, body: unknown, apiKey: string) {
  const details: string[] = [];
  const error = record(body) && record(body.error) ? body.error : null;
  if (error && typeof error.message === 'string') details.push(error.message);
  if (error && record(error.metadata) && typeof error.metadata.raw === 'string') {
    try {
      const raw: unknown = JSON.parse(error.metadata.raw);
      const nested = record(raw) && record(raw.error) ? raw.error : raw;
      if (record(nested) && typeof nested.message === 'string') details.push(nested.message);
    } catch { /* Keep the public message; never display an arbitrary raw body. */ }
  }
  const detail = [...new Set(details)].join(' ').replaceAll(apiKey, '[redacted]')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 400);
  return new Error(`${httpError(status, detail)}${detail ? ` ${detail}` : ''}`);
}

export async function completeReply(
  messages: Message[], settings: ModelSettings, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<Completion> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'AGSpeak' },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages: requestMessages(messages),
        max_tokens: 512,
        stream: false,
        reasoning: { enabled: false },
      }),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw providerError(response.status, body, settings.apiKey);
    }
    const data: unknown = await response.json();
    if (!record(data)) throw new Error('OpenRouter returned an invalid response.');
    if (record(data.error)) throw providerError(typeof data.error.code === 'number' ? data.error.code : 502, data, settings.apiKey);
    const first: unknown = Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message: unknown = record(first) ? first.message : undefined;
    if (!record(message) || typeof message.content !== 'string' || !message.content.trim()) {
      throw new Error('The model returned no text. You can retry or choose another model.');
    }
    const cost = record(data.usage) && typeof data.usage.cost === 'number' ? data.usage.cost : null;
    return { text: message.content, model: typeof data.model === 'string' ? data.model : settings.model, cost };
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('The request timed out. You can retry it.', { cause });
    if (cause instanceof Error && cause.message.startsWith('Network request failed')) throw new Error('Couldn’t reach OpenRouter. Check your connection and retry.', { cause });
    throw cause;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
