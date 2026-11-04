import { useQuery } from '@tanstack/react-query';
import { modelCatalogQuery, routerUsageQuery, usagePresentation } from './routerQueries';
import { catalogStorage } from './catalogStorage';

export function useModelCatalog() {
  const query = useQuery(modelCatalogQuery(catalogStorage));
  return {
    models: query.data ?? [], loading: query.isFetching,
    error: query.isError ? 'Couldn’t refresh models. Tap refresh to retry.' : null,
    refresh: () => { void query.refetch(); },
  };
}

export function useRouterUsage(savedKey: string) {
  const options = routerUsageQuery(savedKey);
  const query = useQuery(options);
  return {
    ...usagePresentation(savedKey, Boolean(options.enabled), query.data, query.error),
    loading: query.isFetching, canRefresh: Boolean(options.enabled),
    refresh: () => { if (options.enabled) void query.refetch(); },
  };
}
