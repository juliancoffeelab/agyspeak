import type { RouterModel } from "./routerMetadata";

export function encodeCatalog(models: RouterModel[]) {
  return { version: 1, models };
}

export function decodeCatalog(value: unknown): RouterModel[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("models" in value) ||
    !Array.isArray(value.models) ||
    !value.models.length
  )
    throw new Error("Invalid saved model catalog.");
  return value.models.map((item: unknown) => {
    const price = (value: unknown): value is number | null =>
      value === null ||
      (typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      !("audio" in item) ||
      typeof item.audio !== "boolean" ||
      !("inputPrice" in item) ||
      !price(item.inputPrice) ||
      !("outputPrice" in item) ||
      !price(item.outputPrice)
    )
      throw new Error("Invalid saved model catalog.");
    return {
      id: item.id,
      name: item.name,
      audio: item.audio,
      inputPrice: item.inputPrice,
      outputPrice: item.outputPrice,
    };
  });
}
