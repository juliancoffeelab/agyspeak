export type Draft = { text: string; version: number };

export function editDraft(draft: Draft, text: string) {
  if (draft.text === text) return;
  draft.text = text;
  draft.version++;
}

// Clearing before the async save keeps native keyboard edits for the next turn.
export async function submitDraft(
  draft: Draft,
  save: (text: string) => Promise<boolean>,
  clear: () => void,
  restore: (text: string) => void,
) {
  const original = draft.text;
  if (!original.trim()) return false;
  editDraft(draft, '');
  const clearedVersion = draft.version;
  clear();
  let saved = false;
  try {
    saved = await save(original.trim());
    return saved;
  } finally {
    if (!saved && draft.version === clearedVersion) {
      editDraft(draft, original);
      restore(original);
    }
  }
}
