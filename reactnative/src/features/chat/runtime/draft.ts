export type TurnResult = "refused" | "saved";

export type Draft = { text: string; version: number };

export function editDraft(draft: Draft, text: string) {
  if (draft.text === text) return;
  draft.text = text;
  draft.version++;
}

// Clearing before the async save keeps native keyboard edits for the next turn.
export async function submitDraft(
  draft: Draft,
  save: (text: string) => Promise<TurnResult>,
  clear: () => void,
  restore: (text: string) => void,
  allowEmpty: boolean,
): Promise<TurnResult> {
  const original = draft.text;
  if (!original.trim() && !allowEmpty) return "refused";
  editDraft(draft, "");
  const clearedVersion = draft.version;
  clear();
  let result: TurnResult = "refused";
  try {
    result = await save(original.trim());
    return result;
  } finally {
    // A saved turn consumed the text; only a refused one gives it back.
    if (result === "refused" && draft.version === clearedVersion) {
      editDraft(draft, original);
      restore(original);
    }
  }
}
