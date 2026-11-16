import { File, Paths } from "expo-file-system";
import { decodeCatalog, encodeCatalog } from "./modelCatalog.ts";
import type { RouterModel } from "./routerMetadata";

const file = new File(Paths.document, "openrouter-models-v4.json");

export const catalogStorage = {
  // Older caches retained audio alone; image capability must be fetched afresh.
  read: async (): Promise<RouterModel[]> =>
    decodeCatalog(JSON.parse(await file.text()) as unknown),
  write: async (models: RouterModel[]) => {
    await file.write(JSON.stringify(encodeCatalog(models)));
  },
};
