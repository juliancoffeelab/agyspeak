import { editDraft, submitDraft, type Draft } from "./draft.ts";

// One composer session owns its native-input value and debounce timer. Writes
// are supplied by the controller's SQLite queue; edits never publish chat state.
export class PersistentDraft {
  readonly key: number;
  readonly initialText: string;
  readonly value: Draft;
  chatId: string | null;
  suspended = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  private submitting = false;
  private clearedVersion: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly persist: (text: string) => Promise<void>;
  private readonly onError: () => void;

  constructor(
    key: number,
    chatId: string | null,
    text: string,
    persist: (text: string) => Promise<void>,
    onError: () => void,
  ) {
    this.key = key;
    this.chatId = chatId;
    this.initialText = text;
    this.value = { text, version: 0 };
    this.persist = persist;
    this.onError = onError;
  }
  edit(text: string) {
    if (this.closed || this.suspended || this.value.text === text) return;
    editDraft(this.value, text);
    this.dirty = true;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(this.onError);
    }, 400);
  }
  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  flush() {
    this.cancelTimer();
    if (
      this.closed ||
      !this.dirty ||
      (this.submitting && this.value.version === this.clearedVersion)
    )
      return this.pending;
    this.dirty = false;
    this.pending = this.persist(this.value.text).catch((cause) => {
      this.dirty = true;
      throw cause;
    });
    return this.pending;
  }
  async submit(
    save: (text: string) => Promise<boolean>,
    clear: () => void,
    restore: (text: string) => void,
  ) {
    this.cancelTimer();
    this.submitting = true;
    this.clearedVersion = null;
    try {
      return await submitDraft(
        this.value,
        save,
        () => {
          this.clearedVersion = this.value.version;
          clear();
        },
        restore,
      );
    } finally {
      this.submitting = false;
      // The message transaction consumes the old draft. Preserve any text typed
      // while it was saving, or the original text restored after a failed save.
      this.dirty = true;
      if (!this.closed) await this.flush();
    }
  }
  close() {
    this.cancelTimer();
    this.closed = true;
    this.suspended = true;
  }
}
