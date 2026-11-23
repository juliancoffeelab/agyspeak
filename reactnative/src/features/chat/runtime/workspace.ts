import { createStore, type StoreApi } from "zustand/vanilla";

import {
  ChatRuntime,
  NOT_CONNECTED,
  providerMessages,
  type ChatView,
  type Input,
} from "./chatRuntime.ts";
import { validatePhotos } from "./inputLimits.ts";
import {
  replyRequest,
  summarizeLevels,
  type Log,
  type ModelFacts,
  type PhotoRef,
  type UserEntry,
} from "./log.ts";
import { openChat, refusal, step, type Command } from "./machine.ts";
import { PersistentDraft } from "./PersistentDraft.ts";
import type { TurnResult } from "./draft.ts";
import type {
  ChatList,
  ChatRepository,
  Conversation,
  NewChat,
  Workspace,
} from "../storage/repository.ts";
import type {
  AudioInput,
  ChatSummary,
  PhotoAttachment,
  PhotoInput,
  PhotoReference,
} from "../storage/contracts.ts";
import {
  validateAudioPayload,
  type StreamReply,
} from "../../../providers/openrouter/transport.ts";

// The chats this session works with: the list, the open chat and its draft,
// and one runtime for each chat opened, which goes on while another is
// open. Commands go to the open chat's machine, which says whether they are
// taken; nothing here decides that.

const DRAFT_UNSAVED =
  "Couldn’t save the message you were typing. Leaving the app will lose it.";
const KEPT_DRAFT_UNSAVED =
  "Couldn’t save the message you were typing in that chat. Leaving the app will lose it.";
const NOT_REMOVED = "Couldn’t delete that chat. Please try again.";
const BUSY = "Another change is still being saved.";

export type WorkspaceState = {
  // Null until the chats are first read.
  chats: ChatSummary[] | null;
  // The open chat, as its runtime shows it.
  open: StoreApi<ChatView>;
  draft: PersistentDraft;
  // A chat is being opened or deleted, or its model saved.
  busy: boolean;
  // The chats whose machine is running a request.
  running: readonly string[];
  // Why the saved chats couldn't be listed, until they are.
  chatsFailure: unknown;
  // The chat that couldn’t be opened (null: the new chat) and why, until
  // another is asked for.
  openFailure: { id: string | null; error: unknown } | null;
  error: string | null;
};

export type ModelInfo = {
  // The model that answers requests to it now (see `answeringModel`).
  answering: (model: string) => string;
  contextLength: (model: string) => number | null;
  maxOutput: (model: string) => number;
  audioIssue: (model: string) => string | null;
  imageIssue: (model: string) => string | null;
};

export type WorkspaceOptions = {
  store: ChatRepository;
  newChat: NewChat;
  reply: StreamReply;
  apiKey: () => string | null;
  defaultModel: () => string;
  models: ModelInfo;
  now: () => number;
};

const RUNNING = ["making-room", "writing", "compacting", "continuing"];
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export class ChatWorkspace {
  readonly state: StoreApi<WorkspaceState>;
  private readonly options: WorkspaceOptions;
  private readonly runtimes = new Map<string, ChatRuntime>();
  // A chat's model as it was chosen before its first message, by chat.
  private readonly chosen = new Map<string, string | null>();
  // Drafts left with edits that failed to save, or with a message being
  // sent, kept until their chat is opened again or deleted, and saved again
  // on dispose.
  private readonly retained = new Map<string, PersistentDraft>();
  // What each chat's message being sent is answered with, by chat: at most
  // one is sent and unsaved at a time.
  private readonly sending = new Map<string, (result: TurnResult) => void>();
  private draftKey = 0;
  private chatsSeq = 0;
  private disposed = false;

  constructor(options: WorkspaceOptions) {
    this.options = options;
    const { newChat } = options;
    const runtime = this.runtimeFor({
      id: newChat.id,
      log: [],
      selectedModel: newChat.selectedModel,
      thumbnails: {},
    });
    this.state = createStore<WorkspaceState>()(() => ({
      chats: null,
      open: runtime.view,
      draft: this.createDraft(
        newChat.id,
        newChat.draft.text,
        newChat.draft.photos,
      ),
      busy: false,
      running: [],
      chatsFailure: null,
      openFailure: null,
      error: null,
    }));
  }

  private get current() {
    return this.state.getState();
  }
  private publish(update: Partial<WorkspaceState>) {
    this.state.setState(update);
  }
  private get openRuntime() {
    const runtime = this.runtimes.get(this.current.open.getState().id);
    if (!runtime) throw new Error("The open chat has no runtime.");
    return runtime;
  }

  // What is known of `model` as far as requests are concerned.
  facts(model: string): ModelFacts {
    const { models } = this.options;
    return {
      id: model,
      answering: models.answering(model),
      contextLength: models.contextLength(model),
      maxOutput: models.maxOutput(model),
      issues: {
        audio: models.audioIssue(model),
        image: models.imageIssue(model),
      },
    };
  }

  // A chat's model: the one it was sent with, else the one chosen for it,
  // else the default.
  private modelOf(log: Log, chatId: string, selected: string | null) {
    if (log.length > 0 && selected !== null) return selected;
    return this.chosen.get(chatId) ?? selected ?? this.options.defaultModel();
  }

  private runtimeFor(conversation: Conversation): ChatRuntime {
    const existing = this.runtimes.get(conversation.id);
    if (existing) return existing;
    const { id, log, selectedModel } = conversation;
    if (log.length === 0) this.chosen.set(id, selectedModel);
    const chat = openChat(
      log,
      this.facts(this.modelOf(log, id, selectedModel)),
      this.options.now(),
    );
    const { store } = this.options;
    const runtime = new ChatRuntime(id, chat, conversation.thumbnails, {
      apiKey: this.options.apiKey,
      reply: this.options.reply,
      readMedia: (keys) => store.readMedia(keys),
      writeLog: (keep, entries, sent, model, now) =>
        store.writeLog(id, keep, entries, sent, model, now),
      onList: (list) => this.applyList(list),
      onSaved: () => this.answer(id, "saved"),
      onReturned: (message) => {
        this.giveBack(id, message);
        this.answer(id, "refused");
      },
      now: this.options.now,
    });
    runtime.view.subscribe((view, previous) => {
      if (view.chat.phase.kind !== previous.chat.phase.kind)
        this.refreshRunning();
    });
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private answer(chatId: string, result: TurnResult) {
    const resolve = this.sending.get(chatId);
    this.sending.delete(chatId);
    resolve?.(result);
  }

  // A message the chat gave back, not sent or discarded: its text and photos
  // become the chat's draft when nothing is typed or attached there, which
  // is kept otherwise; the two aren't merged. A recording has no place in
  // the draft: the composer keeps one until its send is answered.
  private giveBack(chatId: string, message: UserEntry) {
    const { text, photos } = message;
    if (!text && photos.length === 0) return;
    const open = this.current.draft;
    const draft =
      open.chatId === chatId ? open : (this.retained.get(chatId) ?? null);
    const restored = draft
      ? draft.restore(text, photos)
      : this.options.store.restoreDraft(chatId, text, photos);
    restored.catch((cause: unknown) => {
      console.error("Couldn’t give the message back to the draft.", cause);
      this.publish({ error: DRAFT_UNSAVED });
    });
  }

  private refreshRunning() {
    const running = [...this.runtimes.entries()]
      .filter(([, runtime]) => RUNNING.includes(runtime.chat.phase.kind))
      .map(([id]) => id);
    if (running.join() !== this.current.running.join())
      this.publish({ running });
  }

  private applyList(list: ChatList) {
    if (list.seq <= this.chatsSeq) return;
    this.chatsSeq = list.seq;
    this.publish({ chats: list.chats, chatsFailure: null });
  }

  private createDraft(chatId: string, text: string, photos: PhotoAttachment[]) {
    const { store } = this.options;
    return new PersistentDraft(
      ++this.draftKey,
      chatId,
      text,
      (value) => store.saveDraft(chatId, value),
      () => this.publish({ error: DRAFT_UNSAVED }),
      {
        initial: photos,
        read: () => store.readPhotoDraftData(chatId),
        add: (inputs) => store.addPhotoDraft(chatId, inputs),
        remove: (id) => store.removePhotoDraft(chatId, id),
        restore: (photos) => store.restorePhotoDraft(chatId, photos),
      },
    );
  }

  // Why the open chat takes no command of `kind` now, or null.
  refusal(kind: Command["kind"]): string | null {
    return refusal(this.openRuntime.chat, kind);
  }

  // Why the open chat wouldn't take a message of `text` and `photos`, or a
  // recording of `durationMillis`, now: the send stepped and set aside.
  sendIssue(
    message:
      | { kind: "text"; text: string; photos: readonly PhotoAttachment[] }
      | { kind: "recording"; durationMillis: number; format: string },
  ): string | null {
    const { chat } = this.openRuntime;
    const command: Command =
      message.kind === "text"
        ? {
            kind: "send",
            text: message.text.trim(),
            photos: message.photos.map((photo) => ({
              key: String(photo.id),
              width: photo.width,
              height: photo.height,
              encodedLength: photo.encodedLength,
            })),
          }
        : {
            kind: "send-recording",
            audio: {
              key: "",
              format: message.format,
              encodedLength: 0,
              durationMillis: message.durationMillis,
              levels: null,
            },
          };
    return step(chat, command, this.options.now()).refused;
  }

  private reject(issue: string): TurnResult {
    this.publish({ error: issue });
    return "refused";
  }

  // Runs a command that makes requests in the open chat; its refusal, or
  // null when it was taken.
  command(command: Exclude<Input, { kind: "send" | "send-recording" }>) {
    if (
      command.kind !== "stop" &&
      command.kind !== "discard" &&
      command.kind !== "save-again" &&
      command.kind !== "change-model" &&
      this.options.apiKey() === null
    )
      return NOT_CONNECTED;
    return this.openRuntime.dispatch(command);
  }

  // How a message chat `chatId` took is answered: "saved" once the write
  // of it commits, which takes it from the draft; "refused" when the chat
  // gives it back unsent. Until then the message is the draft's.
  private answered(chatId: string): Promise<TurnResult> {
    return new Promise((resolve) => this.sending.set(chatId, resolve));
  }

  // Sends words and photos in the open chat. The photos are the draft's,
  // as it holds them now; they are saved for the message before it is sent,
  // and shown taken from the draft once the chat takes it.
  async send(text: string, photos: PhotoInput[]): Promise<TurnResult> {
    if (this.options.apiKey() === null) return this.reject(NOT_CONNECTED);
    const draft = this.current.draft;
    const runtime = this.openRuntime;
    const chatId = runtime.view.getState().id;
    try {
      if (photos.length) validatePhotos(photos);
    } catch (cause) {
      return this.reject(errorText(cause));
    }
    const issue = this.sendIssue({
      kind: "text",
      text,
      photos: draft.getPhotos(),
    });
    if (issue) return this.reject(issue);
    let refs: PhotoRef[] = [];
    if (photos.length) {
      try {
        const staged = await this.options.store.stagePhotoDraft(chatId);
        refs = staged.photos;
        runtime.addThumbnails(staged.thumbnails);
      } catch (cause) {
        console.error("Couldn’t save the photos.", cause);
        return this.reject(errorText(cause));
      }
    }
    const refused = runtime.dispatch({
      kind: "send",
      text: text.trim(),
      photos: refs,
    });
    if (refused) return this.reject(refused);
    if (photos.length) draft.consumePhotos();
    return this.answered(chatId);
  }

  // Sends a recording in the open chat.
  async sendAudio(audio: AudioInput): Promise<TurnResult> {
    if (this.options.apiKey() === null) return this.reject(NOT_CONNECTED);
    try {
      validateAudioPayload(audio);
    } catch (cause) {
      return this.reject(errorText(cause));
    }
    const runtime = this.openRuntime;
    const issue = this.sendIssue({
      kind: "recording",
      durationMillis: audio.durationMillis ?? 0,
      format: audio.format,
    });
    if (issue) return this.reject(issue);
    let key: string;
    try {
      key = await this.options.store.addRecording(
        runtime.view.getState().id,
        audio.data,
      );
    } catch (cause) {
      console.error("Couldn’t save the recording.", cause);
      return this.reject(errorText(cause));
    }
    const refused = runtime.dispatch({
      kind: "send-recording",
      audio: {
        key,
        format: audio.format,
        encodedLength: audio.data.length,
        durationMillis: audio.durationMillis ?? null,
        levels: audio.levels ? summarizeLevels(audio.levels) : null,
      },
    });
    return refused
      ? this.reject(refused)
      : this.answered(runtime.view.getState().id);
  }

  // Saves the open chat's model and gives it to its machine. Rejects with
  // why when it can't be changed; the caller shows that.
  async chooseModel(model: string) {
    if (this.disposed || this.current.busy) throw new Error(BUSY);
    const runtime = this.openRuntime;
    const reason = refusal(runtime.chat, "change-model");
    if (reason) throw new Error(reason);
    const chatId = runtime.view.getState().id;
    this.publish({ busy: true, error: null });
    try {
      await this.options.store.setSelectedModel(chatId, model);
    } finally {
      this.publish({ busy: false });
    }
    if (runtime.chat.log.length === 0) this.chosen.set(chatId, model);
    const refused = runtime.dispatch({
      kind: "change-model",
      model: this.facts(model),
    });
    if (refused) throw new Error(refused);
  }

  // What a model takes may have changed: the catalog loaded, or the default
  // model changed. Every chat is told what is known of its model now.
  inputsChanged() {
    for (const [id, runtime] of this.runtimes) {
      const { chat } = runtime;
      const model =
        chat.log.length > 0
          ? chat.model.id
          : this.modelOf(chat.log, id, this.chosen.get(id) ?? null);
      const facts = this.facts(model);
      // A chat with nothing in it yet answers with the default model.
      if (model !== chat.model.id)
        runtime.dispatch({ kind: "change-model", model: facts });
      else runtime.dispatch({ kind: "capabilities", model: facts });
    }
  }

  // A photo whole, of a message or of the draft.
  readPhoto(reference: PhotoReference) {
    return this.options.store.readPhoto(reference);
  }

  // What the model is given from compaction `index` of the open chat on,
  // with its media.
  async shownFrom(log: Log, index: number) {
    return providerMessages(replyRequest(log.slice(0, index + 1)), (keys) =>
      this.options.store.readMedia(keys),
    );
  }

  async flushDraft() {
    try {
      await this.current.draft.flush();
      return true;
    } catch {
      this.publish({ error: DRAFT_UNSAVED });
      return false;
    }
  }

  private open(workspace: Workspace) {
    this.applyList(workspace);
    const runtime = this.runtimeFor(workspace.chat);
    // Returning to a kept draft uses its newest edits, not older storage.
    const kept = this.retained.get(workspace.chat.id);
    if (kept) {
      this.retained.delete(workspace.chat.id);
      kept.suspended = false;
    }
    this.publish({
      open: runtime.view,
      draft:
        kept ??
        this.createDraft(
          workspace.chat.id,
          workspace.draft.text,
          workspace.draft.photos,
        ),
      chats: workspace.chats,
      chatsFailure: null,
    });
  }

  // Opens a chat; null opens the new chat. A chat whose runtime is going on
  // opens as it is, ahead of storage. False when another change is being
  // saved or the chat couldn't be opened, which is published.
  async select(id: string | null) {
    if (this.disposed || this.current.busy) return false;
    const previous = this.current.draft;
    previous.suspended = true;
    this.publish({ busy: true, error: null, openFailure: null });
    // A failed draft save does not block navigation; the draft is kept, as
    // one whose message is being sent is.
    const failed = await previous.flush().then(
      () => false,
      () => true,
    );
    const kept = failed || previous.sending;
    try {
      const { store } = this.options;
      const workspace = await (id === null
        ? store.activateNew()
        : store.activate(id));
      if (kept) this.retained.set(previous.chatId, previous);
      else previous.close();
      this.open(workspace);
      if (failed && this.retained.get(previous.chatId) === previous)
        this.publish({ error: KEPT_DRAFT_UNSAVED });
      return true;
    } catch (error) {
      console.error("Couldn’t open the chat.", error);
      previous.suspended = false;
      this.publish({
        openFailure: { id, error: error ?? new Error("Unknown failure.") },
      });
      return false;
    } finally {
      this.publish({ busy: false });
    }
  }

  // Lists the saved chats. Startup opens the new chat without waiting for
  // this; a newer list from any write supersedes the result.
  async loadChats() {
    if (this.disposed) return;
    try {
      const list = await this.options.store.readChats();
      if (!this.disposed) this.applyList(list);
    } catch (cause) {
      if (!this.disposed)
        this.publish({ chatsFailure: cause ?? new Error("Unknown failure.") });
    }
  }

  dismissError() {
    this.publish({ error: null, openFailure: null });
  }

  // Deletes a chat once its runtime has stopped, so nothing it was doing
  // can write it again.
  async remove(id: string) {
    if (this.disposed || this.current.busy) return false;
    this.publish({ busy: true, error: null });
    const previous = this.current.draft;
    const deletingCurrent = previous.chatId === id;
    if (deletingCurrent) previous.suspended = true;
    try {
      const runtime = this.runtimes.get(id);
      await runtime?.settle();
      const replacement = await this.options.store.remove(id);
      this.runtimes.delete(id);
      this.chosen.delete(id);
      // A send from a deleted chat is never answered; its composer is gone.
      this.sending.delete(id);
      await runtime?.dispose();
      this.refreshRunning();
      const kept = this.retained.get(id);
      if (kept) {
        kept.close();
        this.retained.delete(id);
      }
      if (deletingCurrent) {
        previous.close();
        this.open(replacement);
      } else this.applyList(replacement);
      return true;
    } catch (cause) {
      console.error("Couldn’t delete the chat.", cause);
      if (deletingCurrent) previous.suspended = false;
      this.publish({ error: NOT_REMOVED });
      return false;
    } finally {
      this.publish({ busy: false });
    }
  }

  async dispose() {
    this.disposed = true;
    for (const runtime of this.runtimes.values()) await runtime.dispose();
    this.runtimes.clear();
    await this.flushDraft();
    this.current.draft.close();
    for (const draft of this.retained.values()) {
      await draft.flush().catch(() => {});
      draft.close();
    }
    this.retained.clear();
  }
}
