import { parseKeyInput } from './settings.ts';
import { queryOptions } from '@tanstack/react-query';
import { parseModels, parseUsage, routerGet, RouterAuthenticationError } from './routerMetadata.ts';
import type { RouterModel, RouterUsage } from './routerMetadata';

type CatalogStorage = { read: () => Promise<RouterModel[]>; write: (models: RouterModel[]) => Promise<void> };
const catalogKey = ['openrouter', 'models'] as const;

export function modelCatalogQuery(storage: CatalogStorage, fetcher: typeof fetch = fetch) {
  return queryOptions({
    queryKey: catalogKey,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async ({ signal, client }) => {
      if (!client.getQueryData(catalogKey)) {
        try { return await storage.read(); }
        catch { /* Download the catalog when its saved file is absent or invalid. */ }
      }
      const models = parseModels(await routerGet('models', signal, undefined, fetcher));
      // Keep the usable in-memory result even if the device cannot write its cache.
      await storage.write(models).catch(() => undefined);
      return models;
    },
  });
}

export function routerUsageQuery(submitted: string | null, fetcher: typeof fetch = fetch) {
  let apiKey = '';
  try { if (submitted?.trim()) apiKey = parseKeyInput(submitted); } catch { /* Invalid entries never start a query. */ }
  return queryOptions({
    queryKey: ['openrouter', 'usage', apiKey],
    enabled: Boolean(apiKey),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const [key, credits] = await Promise.all([
        routerGet('key', signal, apiKey, fetcher),
        routerGet('credits', signal, apiKey, fetcher).catch(() => null),
      ]);
      return parseUsage(key, credits);
    },
  });
}

export function usagePresentation(submitted: string | null, valid: boolean, data: RouterUsage | undefined, error: Error | null) {
  const rejected = error instanceof RouterAuthenticationError;
  const state = !submitted?.trim() ? 'empty' : !valid || rejected ? 'invalid'
    : data ? 'ready' : error ? 'error' : 'loading';
  return {
    state, usage: state === 'invalid' || state === 'empty' ? null : data ?? null,
    error: rejected ? 'OpenRouter rejected this key.' : error ? 'Couldn’t refresh spending. Check your key or retry.' : null,
  };
}
