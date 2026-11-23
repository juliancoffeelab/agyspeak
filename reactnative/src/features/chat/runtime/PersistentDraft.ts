import type { PhotoAttachment, PhotoInput } from "../storage/contracts";

import {
  editDraft,
  submitDraft,
  type Draft,
  type TurnResult,
} from "./draft.ts";
import type { PhotoRef } from "./log.ts";

// One composer session owns its native-input value and debounce timer. Writes
// are supplied by the controller's SQLite queue, for the chat this draft
// belongs to; edits never publish chat state.
type PhotoStorage = {
  initial: PhotoAttachment[];
  read: () => Promise<PhotoInput[]>;
  add: (photos: PhotoInput[]) => Promise<PhotoAttachment[]>;
  remove: (id: number) => Promise<PhotoAttachment[]>;
  // Copies a message's photos in when the draft has none; its photos.
  restore: (photos: readonly PhotoRef[]) => Promise<PhotoAttachment[]>;
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
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  // What shows the draft's text, told when the draft is given text.
  private readonly restoredListeners = new Set<(text: string) => void>();
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

  // Calls `listener` with the text a message given back puts in the draft.
  onRestored(listener: (text: string) => void) {
    this.restoredListeners.add(listener);
    return () => {
      this.restoredListeners.delete(listener);
    };
  }

  getPhotos = () => this.photoSnapshot;
  // A closed draft no longer owns its storage.
  readPhotos() {
    return this.closed ? Promise.resolve([]) : this.photoStorage.read();
  }
  // The photos of a message being sent stay the draft's until it is
  // saved, so none are added or removed meanwhile.
  async addPhotos(photos: PhotoInput[]) {
    if (this.closed || this.suspended || this.submitting) return;
    this.showPhotos(await this.photoStorage.add(photos));
  }
  async removePhoto(id: number) {
    if (this.closed || this.suspended || this.submitting) return;
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

  // A message given back (see `ChatWorkspace`): its text and photos become
  // the draft's when nothing is typed or attached in it. What is there is
  // kept, and the message dropped, otherwise: the two aren't merged.
  async restore(text: string, photos: readonly PhotoRef[]) {
    if (
      this.closed ||
      this.value.text.trim() !== "" ||
      this.photoSnapshot.length > 0
    )
      return;
    if (text) {
      editDraft(this.value, text);
      this.notify();
      this.restoredListeners.forEach((listener) => listener(text));
      this.dirty = true;
      void this.flush().catch(this.onError);
    }
    if (photos.length) this.showPhotos(await this.photoStorage.restore(photos));
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
  // Whether a message submitted from the draft is still being sent.
  get sending() {
    return this.submitting;
  }
  // Saves the text, except while a message is being sent: the saved draft
  // holds that message until its write takes it, and what is typed
  // meanwhile is saved after.
  flush() {
    if (this.submitting) {
      this.cancelTimer();
      return this.pending;
    }
    return this.save();
  }
  private save() {
    this.cancelTimer();
    if (this.closed || !this.dirty) return this.pending;
    this.dirty = false;
    this.pending = this.persist(this.value.text).catch((cause) => {
      this.dirty = true;
      throw cause;
    });
    return this.pending;
  }
  async submit(
    save: (text: string) => Promise<TurnResult>,
    clear: () => void,
    restore: (text: string) => void,
    allowEmpty: boolean,
  ) {
    if (this.submitting) return "refused";
    this.submitting = true;
    try {
      // The saved draft holds exactly the message sent.
      await this.save().catch(this.onError);
      return await submitDraft(
        this.value,
        save,
        () => {
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
      // The message's write took the saved draft, or it was given back:
      // save what the draft holds now, typed meanwhile or given back.
      this.dirty = true;
      if (!this.closed) await this.flush();
    }
  }
  close() {
    this.cancelTimer();
    this.closed = true;
    this.suspended = true;
    this.listeners.clear();
    this.restoredListeners.clear();
  }
}
