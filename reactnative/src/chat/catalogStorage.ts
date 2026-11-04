import { File, Paths } from "expo-file-system";
import { decodeCatalog, encodeCatalog } from "./modelCatalog.ts";
import { parseModels } from "./routerMetadata";
import type { RouterModel } from "./routerMetadata";

const file = new File(Paths.document, "openrouter-models-v3.json");
const legacyFile = new File(Paths.document, "openrouter-models-v2.json");

export const catalogStorage = {
  read: async (): Promise<RouterModel[]> => {
    try {
      return decodeCatalog(JSON.parse(await file.text()) as unknown);
    } catch {
      // Preserve an existing offline catalog while moving to our own format.
      const models = parseModels(
        JSON.parse(await legacyFile.text()) as unknown,
      );
      await file
        .write(JSON.stringify(encodeCatalog(models)))
        .catch(() => undefined);
      return models;
    }
  },
  write: async (models: RouterModel[]) => {
    await file.write(JSON.stringify(encodeCatalog(models)));
  },
};
