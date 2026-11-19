import { z } from "zod";
import { createStore } from "zustand/vanilla";

import type { OrderedDatabase } from "../storage/database.ts";

export const DEFAULT_MODEL = "openrouter/free";

// A saved model is stored trimmed. No speech language means the device's
// default voice; message-level choices are not preferences.
const stored = z.object({
  defaultModel: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  speechLanguage: z.string().min(1).nullable(),
});
export type Preferences = z.infer<typeof stored>;

// The database upgrade writes the row, so a missing or invalid one is damage
// and rejects with the stored data intact.
export async function readPreferences(
  db: OrderedDatabase,
): Promise<Preferences> {
  const row = await db.run((connection) =>
    connection.getFirstAsync(
      "SELECT default_model AS defaultModel, speech_language AS speechLanguage FROM preferences WHERE id = 1",
    ),
  );
  const parsed = stored.safeParse(row);
  if (!parsed.success) throw new Error("Saved preferences are invalid.");
  return parsed.data;
}

// The single runtime owner of saved preferences. A change is published only
// after it is durable. The database orders the saves and finishes the
// accepted ones before it closes.
export function createPreferences(db: OrderedDatabase, initial: Preferences) {
  const state = createStore<Preferences>(() => initial);
  async function save(
    column: string,
    update: Partial<Preferences>,
    value: unknown,
  ) {
    const { changes } = await db.run((connection) =>
      connection.runAsync(
        `UPDATE preferences SET ${column} = ? WHERE id = 1`,
        value as string | null,
      ),
    );
    if (changes !== 1) throw new Error("Saved preferences are missing.");
    state.setState(update);
  }
  return {
    state,
    saveDefaultModel(input: string) {
      const defaultModel = input.trim() || DEFAULT_MODEL;
      return save("default_model", { defaultModel }, defaultModel);
    },
    saveSpeechLanguage(speechLanguage: string | null) {
      return save("speech_language", { speechLanguage }, speechLanguage);
    },
  };
}
export type PreferencesOwner = ReturnType<typeof createPreferences>;
