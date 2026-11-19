import { z } from "zod";
import { modelId, type RouterModel } from "./metadata.ts";

const named = z.string().refine((value) => value.trim().length > 0);
const price = z.number().nonnegative().nullable();
// The saved catalog is a disposable copy of `RouterModel[]`. A file that is
// not exactly that is rejected and downloaded again, never converted, so a
// change to the model's fields needs nothing here but the new field.
const catalogCache = z
  .array(
    z.object({
      id: modelId,
      name: named,
      audio: z.boolean(),
      image: z.boolean(),
      inputPrice: price,
      outputPrice: price,
      maxOutput: z.number().int().positive().nullable(),
    }),
  )
  .min(1);

export function decodeCatalog(value: unknown): RouterModel[] {
  const parsed = catalogCache.safeParse(value);
  if (!parsed.success)
    throw new Error("Invalid saved model catalog.", { cause: parsed.error });
  return parsed.data;
}
