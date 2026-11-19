import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  modelCatalogQuery,
  routerUsageQuery,
  usagePresentation,
} from "./queries";
import { catalogStorage } from "./catalogFile";

export function useModelCatalog() {
  const query = useQuery(modelCatalogQuery(catalogStorage, fetch));
  return {
    models: query.data ?? [],
    loading: query.isFetching,
    error: query.isError
      ? "Couldn’t refresh models. Tap refresh to retry."
      : null,
    // The original failure, for its details.
    failure: query.error,
    refresh: () => {
      void query.refetch();
    },
  };
}

type Connection = {
  state: StoreApi<
    { revision: number } & (
      { status: "ready"; connected: boolean } | { status: "reading" | "failed" }
    )
  >;
  capture: () => { apiKey: string; lifetime: number; revision: number } | null;
};

export function useRouterUsage(connection: Connection) {
  // Rerenders on each credential revision, which keys the usage query.
  const key = useStore(connection.state);
  const connected = key.status === "ready" && key.connected;
  const options = routerUsageQuery(connection.capture(), fetch);
  const query = useQuery(options);
  return {
    ...usagePresentation(connected, query.data, query.error),
    failure: connected ? query.error : null,
    loading: query.isFetching,
    canRefresh: connected,
    refresh: () => {
      if (connected) void query.refetch();
    },
  };
}
