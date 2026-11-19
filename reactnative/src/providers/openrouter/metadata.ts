import { z } from "zod";

export type RouterModel = {
  id: string;
  name: string;
  audio: boolean;
  image: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
  // The most tokens the model can write in one reply, when the catalog says.
  maxOutput: number | null;
};
export type RouterUsage = {
  daily: number;
  monthly: number;
  remaining: number | null;
  accountBalance: boolean;
};

export class RouterAuthenticationError extends Error {}

// A finite, nonnegative amount, or null when absent or malformed.
const amount = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null,
  );
const price = z
  .unknown()
  .transform((value) =>
    amount.parse(
      typeof value === "string" && value.trim() ? Number(value) : value,
    ),
  );
const outputLimit = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null,
  );
const modalities = z.array(z.unknown()).optional().catch(undefined);
// A model id is non-empty and holds no whitespace; any other can't be
// requested, wherever it was read from.
export const modelId = z.string().regex(/^\S+$/);
const catalogItem = z.object({
  id: modelId,
  name: z.string(),
  endpoints: z.array(z.unknown()),
  architecture: z
    .object({ input_modalities: modalities, output_modalities: modalities })
    .optional()
    .catch(undefined),
  pricing: z
    .object({ prompt: price, completion: price })
    .optional()
    .catch(undefined),
  top_provider: z
    .object({ max_completion_tokens: outputLimit })
    .optional()
    .catch(undefined),
});
const catalogResponse = z.object({ data: z.array(z.unknown()) });

export function parseModels(value: unknown): RouterModel[] {
  const response = catalogResponse.safeParse(value);
  if (!response.success)
    throw new Error("Invalid model catalog.", { cause: response.error });
  const models: RouterModel[] = [];
  for (const entry of response.data.data) {
    const parsed = catalogItem.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (!item.endpoints.includes("/api/v1/chat/completions")) continue;
    const inputs = item.architecture?.input_modalities;
    const outputs = item.architecture?.output_modalities;
    if (outputs && !outputs.includes("text")) continue;
    models.push({
      inputPrice: item.pricing?.prompt ?? null,
      outputPrice: item.pricing?.completion ?? null,
      maxOutput: item.top_provider?.max_completion_tokens ?? null,
      id: item.id,
      name: item.name,
      image: Boolean(inputs?.includes("image")),
      audio: Boolean(inputs?.includes("audio")),
    });
  }
  if (!models.length) throw new Error("The model catalog is empty.");
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
// A runaway reply stops here: about 20,000 words. A model with a smaller
// limit of its own is asked for no more than that.
const MAX_REPLY_TOKENS = 27_000;
export function replyTokenLimit(
  model: string,
  models: RouterModel[] | undefined,
): number {
  const own = models?.find((item) => item.id === model)?.maxOutput ?? null;
  return own === null ? MAX_REPLY_TOKENS : Math.min(own, MAX_REPLY_TOKENS);
}
// Models whose ID and name contain every search term, the current one first.
export function matchModels(
  models: RouterModel[],
  query: string,
  current: string | null,
): RouterModel[] {
  const terms = query.toLowerCase().trim().split(/\s+/);
  return models
    .filter((model) =>
      terms.every((term) =>
        `${model.id} ${model.name}`.toLowerCase().includes(term),
      ),
    )
    .sort((a, b) => Number(b.id === current) - Number(a.id === current));
}
// A search that names a model ID missing from the catalog, offered as is.
export function customModelId(models: RouterModel[], query: string) {
  const id = query.trim();
  return /^[^\s/]+\/\S+$/.test(id) && !models.some((model) => model.id === id)
    ? id
    : null;
}
const keyResponse = z.object({
  data: z.object({
    usage_daily: amount,
    usage_monthly: amount,
    limit_remaining: amount,
  }),
});
const creditsResponse = z.object({
  data: z.object({ total_credits: amount, total_usage: amount }),
});

export function parseUsage(key: unknown, credits: unknown): RouterUsage {
  const parsed = keyResponse.safeParse(key);
  if (!parsed.success)
    throw new Error("Invalid usage response.", { cause: parsed.error });
  const { usage_daily: daily, usage_monthly: monthly } = parsed.data.data;
  if (daily === null || monthly === null)
    throw new Error("Invalid usage response.");
  const totals = creditsResponse.safeParse(credits);
  const purchased = totals.success ? totals.data.data.total_credits : null;
  const used = totals.success ? totals.data.data.total_usage : null;
  const accountBalance = purchased !== null && used !== null;
  return {
    daily,
    monthly,
    remaining: accountBalance
      ? purchased - used
      : parsed.data.data.limit_remaining,
    accountBalance,
  };
}
export async function routerGet(
  path: string,
  signal: AbortSignal,
  apiKey: string | null,
  fetcher: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 20_000);
  try {
    const response = await fetcher(`https://openrouter.ai/api/v1/${path}`, {
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (response.status === 401 || response.status === 403)
      throw new RouterAuthenticationError("OpenRouter rejected this key.");
    if (!response.ok)
      throw new Error(
        `Couldn’t load OpenRouter data (HTTP ${response.status}).`,
      );
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
export function dollars(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function modelPrice(model: RouterModel): string {
  if (model.inputPrice === null || model.outputPrice === null)
    return "Price unavailable";
  return `${dollars(model.inputPrice * 1_000_000)} in · ${dollars(model.outputPrice * 1_000_000)} out / 1M tokens`;
}
