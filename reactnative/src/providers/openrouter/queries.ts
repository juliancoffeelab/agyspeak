import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  parseModels,
  parseUsage,
  routerGet,
  RouterAuthenticationError,
} from "./metadata.ts";
import type { RouterModel, RouterUsage } from "./metadata";

type CatalogStorage = {
  read: () => Promise<RouterModel[]>;
  write: (models: RouterModel[]) => Promise<void>;
};
export const MODEL_CATALOG_KEY = ["openrouter", "models"] as const;

export function modelCatalogQuery(
  storage: CatalogStorage,
  fetcher: typeof fetch,
) {
  return queryOptions({
    queryKey: MODEL_CATALOG_KEY,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async ({ signal, client }) => {
      if (!client.getQueryData(MODEL_CATALOG_KEY)) {
        try {
          return await storage.read();
        } catch {
          /* Download the catalog when its saved file is absent or invalid. */
        }
      }
      const models = parseModels(
        await routerGet("models", signal, null, fetcher),
      );
      // Keep the usable in-memory result even if the device cannot write its cache.
      await storage.write(models).catch(() => undefined);
      return models;
    },
  });
}

export const USAGE_KEY = ["openrouter", "usage"] as const;

const usageKey = (lifetime: number) => [...USAGE_KEY, lifetime] as const;

// Cancels and removes a connection owner's cached usage, except the revision
// it still uses.
export function discardUsage(
  client: QueryClient,
  lifetime: number,
  keepRevision: number | null,
) {
  const filters = {
    queryKey: usageKey(lifetime),
    predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
      queryKey[USAGE_KEY.length + 1] !== keepRevision,
  };
  void client.cancelQueries(filters);
  client.removeQueries(filters);
}

// Keyed by the non-secret connection owner and revision; the key itself never
// enters the query cache.
export function routerUsageQuery(
  credential: { apiKey: string; lifetime: number; revision: number } | null,
  fetcher: typeof fetch,
) {
  return queryOptions({
    queryKey: credential
      ? [...usageKey(credential.lifetime), credential.revision]
      : [...USAGE_KEY, null],
    enabled: credential !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!credential) throw new Error("OpenRouter is not connected.");
      const [key, credits] = await Promise.all([
        routerGet("key", signal, credential.apiKey, fetcher),
        routerGet("credits", signal, credential.apiKey, fetcher).catch(
          () => null,
        ),
      ]);
      return parseUsage(key, credits);
    },
  });
}

export function usagePresentation(
  connected: boolean,
  data: RouterUsage | undefined,
  error: Error | null,
) {
  const rejected = error instanceof RouterAuthenticationError;
  const state = !connected
    ? "empty"
    : rejected
      ? "invalid"
      : data
        ? "ready"
        : error
          ? "error"
          : "loading";
  return {
    state,
    usage: state === "invalid" || state === "empty" ? null : (data ?? null),
    error: rejected
      ? "OpenRouter rejected this key."
      : error
        ? "Couldn’t refresh spending. Check your key or retry."
        : null,
  };
}
