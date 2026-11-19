import { File, Paths } from "expo-file-system";
import { decodeCatalog } from "./catalogCache.ts";
import type { RouterModel } from "./metadata";

const file = new File(Paths.document, "openrouter-models.json");

export const catalogStorage = {
  read: async (): Promise<RouterModel[]> =>
    decodeCatalog(JSON.parse(await file.text()) as unknown),
  write: async (models: RouterModel[]) => {
    await file.write(JSON.stringify(models));
  },
};
