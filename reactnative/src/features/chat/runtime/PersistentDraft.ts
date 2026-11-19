import type { PhotoAttachment, PhotoInput } from "../storage/contracts";

import { editDraft, submitDraft, type Draft } from "./draft.ts";

// One composer session owns its native-input value and debounce timer. Writes
// are supplied by the controller's SQLite queue, for the chat this draft
// belongs to; edits never publish chat state.
type PhotoStorage = {
  initial: PhotoAttachment[];
  read: () => Promise<PhotoInput[]>;
  add: (photos: PhotoInput[]) => Promise<PhotoAttachment[]>;
  remove: (id: number) => Promise<PhotoAttachment[]>;
};
export class PersistentDraft {
  readonly key: number;
  readonly value: Draft;
  readonly chatId: string;
  suspended = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  private submitting = false;
  private clearedVersion: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private photoSnapshot: PhotoAttachment[];
  private readonly photoStorage: PhotoStorage;
  private readonly persist: (text: string) => Promise<void>;
  private readonly onError: () => void;

  constructor(
    key: number,
    chatId: string,
    text: string,
    persist: (text: string) => Promise<void>,
    onError: () => void,
    photoStorage: PhotoStorage,
  ) {
    this.photoStorage = photoStorage;
    this.photoSnapshot = photoStorage.initial;
    this.key = key;
    this.chatId = chatId;
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
  // A closed draft no longer owns its storage.
  readPhotos() {
    return this.closed ? Promise.resolve([]) : this.photoStorage.read();
  }
  async addPhotos(photos: PhotoInput[]) {
    if (this.closed || this.suspended) return;
    this.showPhotos(await this.photoStorage.add(photos));
  }
  async removePhoto(id: number) {
    if (this.closed || this.suspended) return;
    this.showPhotos(await this.photoStorage.remove(id));
  }
  private showPhotos(saved: PhotoAttachment[]) {
    if (this.closed) return;
    this.photoSnapshot = saved;
    this.notify();
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
  // Whether edits exist that no save has made durable yet.
  get unsaved() {
    return this.dirty;
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
    allowEmpty: boolean,
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
