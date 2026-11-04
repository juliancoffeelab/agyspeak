export type RouterModel = { id: string; name: string; audio: boolean; inputPrice: number | null; outputPrice: number | null };
export type RouterUsage = { daily: number; monthly: number; remaining: number | null; accountBalance: boolean };

export class RouterAuthenticationError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function parseModels(value: unknown): RouterModel[] {
  if (!record(value) || !Array.isArray(value.data)) throw new Error('Invalid model catalog.');
  const models: RouterModel[] = [];
  for (const item of value.data) {
    if (!record(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
    const architecture = record(item.architecture) ? item.architecture : null;
    if (architecture && Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes('text')) continue;
    const pricing = record(item.pricing) ? item.pricing : null;
    const price = (value: unknown) => typeof value === 'string' && value.trim() ? amount(Number(value)) : amount(value);
    models.push({ inputPrice: pricing ? price(pricing.prompt) : null, outputPrice: pricing ? price(pricing.completion) : null, id: item.id, name: item.name, audio: Boolean(architecture && Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes('audio')) });
  }
  if (!models.length) throw new Error('The model catalog is empty.');
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
export function matchModels(models: RouterModel[], query: string): RouterModel[] {
  const terms = query.toLowerCase().trim().split(/\s+/);
  return models.filter(model => terms.every(term => `${model.id} ${model.name}`.toLowerCase().includes(term))).slice(0, 8);
}
export function parseUsage(key: unknown, credits: unknown): RouterUsage {
  if (!record(key) || !record(key.data)) throw new Error('Invalid usage response.');
  const daily = amount(key.data.usage_daily), monthly = amount(key.data.usage_monthly);
  if (daily === null || monthly === null) throw new Error('Invalid usage response.');
  const totals = record(credits) && record(credits.data) ? credits.data : null;
  const purchased = totals ? amount(totals.total_credits) : null;
  const used = totals ? amount(totals.total_usage) : null;
  const accountBalance = purchased !== null && used !== null;
  return { daily, monthly, remaining: accountBalance ? purchased - used : amount(key.data.limit_remaining), accountBalance };
}
export async function routerGet(path: string, signal: AbortSignal, apiKey?: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 20_000);
  try {
    const response = await fetcher(`https://openrouter.ai/api/v1/${path}`, {
      signal: controller.signal, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (response.status === 401 || response.status === 403) throw new RouterAuthenticationError('OpenRouter rejected this key.');
    if (!response.ok) throw new Error(`Couldn’t load OpenRouter data (HTTP ${response.status}).`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
export function dollars(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function modelPrice(model: RouterModel): string {
  if (model.inputPrice === null || model.outputPrice === null) return 'Price unavailable';
  return `${dollars(model.inputPrice * 1_000_000)} in · ${dollars(model.outputPrice * 1_000_000)} out / 1M tokens`;
}
