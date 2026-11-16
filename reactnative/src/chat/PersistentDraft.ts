import type { PhotoAttachment, PhotoInput } from "./history";

import { editDraft, submitDraft, type Draft } from "./draft.ts";

// One composer session owns its native-input value and debounce timer. Writes
// are supplied by the controller's SQLite queue; edits never publish chat state.
type PhotoStorage = {
  initial: PhotoAttachment[];
  read: () => Promise<PhotoInput[]>;
  add: (photos: PhotoInput[]) => Promise<PhotoAttachment[]>;
  remove: (id: number) => Promise<PhotoAttachment[]>;
};
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
  private readonly listeners = new Set<() => void>();
  private photoSnapshot: PhotoAttachment[];
  private readonly photoStorage: PhotoStorage | undefined;
  private readonly persist: (text: string) => Promise<void>;
  private readonly onError: () => void;

  constructor(
    key: number,
    chatId: string | null,
    text: string,
    persist: (text: string) => Promise<void>,
    onError: () => void,
    photoStorage?: PhotoStorage,
  ) {
    this.photoStorage = photoStorage;
    this.photoSnapshot = photoStorage?.initial ?? [];
    this.key = key;
    this.chatId = chatId;
    this.initialText = text;
    this.value = { text, version: 0 };
    this.persist = persist;
    this.onError = onError;
  }
  // Subscribers select small input booleans; native edits don't publish history.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  getPhotos = () => this.photoSnapshot;
  readPhotos() {
    if (!this.photoStorage || this.closed) return Promise.resolve([]);
    return this.photoStorage.read();
  }
  async addPhotos(photos: PhotoInput[]) {
    if (!this.photoStorage || this.closed || this.suspended) return;
    const saved = await this.photoStorage.add(photos);
    if (!this.closed) {
      this.photoSnapshot = saved;
      this.notify();
    }
  }
  async removePhoto(id: number) {
    if (!this.photoStorage || this.closed || this.suspended) return;
    const saved = await this.photoStorage.remove(id);
    if (!this.closed) {
      this.photoSnapshot = saved;
      this.notify();
    }
  }
  consumePhotos() {
    this.photoSnapshot = [];
    this.notify();
  }

  edit(text: string) {
    if (this.closed || this.suspended || this.value.text === text) return;
    editDraft(this.value, text);
    this.notify();
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
    allowEmpty = false,
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
          this.notify();
          clear();
        },
        (text) => {
          this.notify();
          restore(text);
        },
        allowEmpty,
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
    this.listeners.clear();
  }
}
