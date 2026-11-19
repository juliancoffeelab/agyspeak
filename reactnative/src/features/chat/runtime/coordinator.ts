import { createStore, type StoreApi } from "zustand/vanilla";

import { inputIssue, type Outgoing } from "./capability.ts";
import { validatePhotos } from "./inputLimits.ts";
import { PersistentDraft } from "./PersistentDraft.ts";
import {
  createReplyRunner,
  type PendingReply,
  type UnsavedReply,
} from "./replyRunner.ts";
import type {
  AudioInput,
  ChatHistory,
  PhotoAttachment,
  PhotoInput,
  PhotoReference,
  PromptMessage,
} from "../storage/contracts";
import { MAX_MESSAGE_LENGTH } from "../storage/contracts.ts";
import type {
  ChatRepository,
  ChatUpdate,
  NewChat,
  Workspace,
} from "../storage/repository";
import {
  validateAudioPayload,
  type StreamReply,
} from "../../../providers/openrouter/transport.ts";

export type { PendingReply, UnsavedReply } from "./replyRunner.ts";

// The stored chat no longer matches what was said, so it takes no more
// turns; the next start marks the reply failed and retryable.
export const REPLY_UNSAVED =
  "Couldn’t save this reply, so this chat can’t continue. Restarting the app drops the reply and lets you retry it.";
// The open chat's running reply.
export const openReply = (state: ChatState) =>
  state.pending.find((run) => run.chatId === state.history.activeId) ?? null;
const DRAFT_UNSAVED =
  "Couldn’t save the message you were typing. Leaving the app will lose it.";
export type ChatState = {
  // The editable workspace: `activeId` is the conversation it shows.
  history: ChatHistory;
  draft: PersistentDraft;
  saving: boolean;
  // The running replies, at most one per chat.
  pending: readonly PendingReply[];
  // Finished replies whose save failed, shown from memory.
  unsavedReplies: readonly UnsavedReply[];
  // Why the saved chats couldn't be listed, until `loadChats` succeeds.
  chatsFailure: unknown;
  // The chat that couldn’t be opened (null: the new chat) and why, until
  // another is asked for.
  openFailure: { id: string | null; error: unknown } | null;
  error: string | null;
};

type ReplySettings = { apiKey: string | null; model: string };
export type ChatCoordinatorOptions = {
  store: ChatRepository;
  // The new chat, which is open at first: its model choice and draft.
  newChat: NewChat;
  reply: StreamReply;
  // The key, null while none is connected, and the default model, read once
  // when a reply is admitted.
  settings: () => ReplySettings;
  audioIssue: (model: string) => string | null;
  imageIssue: (model: string) => string | null;
  // Milliseconds on a monotonic clock, for reply timing.
};

// Orders what crosses the draft, the reply runner and the repository, and
// publishes one state. Commands name their chat or reply explicitly.
export class ChatCoordinator {
  private readonly store: ChatRepository;
  private readonly imageIssue: (model: string) => string | null;
  private readonly audioIssue: (model: string) => string | null;
  private readonly settings: () => ReplySettings;
  private readonly runner;
  readonly state: StoreApi<ChatState>;
  private disposed = false;
  private draftKey = 0;
  // Results older than the last applied one are obsolete reads.
  private chatsSeq = 0;
  private conversationSeq = 0;
  // Drafts left with edits that failed to save. Each stays in memory until
  // its chat is opened again or deleted, and is saved again on dispose.
  private readonly retained = new Map<string, PersistentDraft>();

  constructor({
    store,
    newChat,
    reply,
    settings,
    audioIssue,
    imageIssue,
  }: ChatCoordinatorOptions) {
    this.store = store;
    this.audioIssue = audioIssue;
    this.imageIssue = imageIssue;
    this.settings = settings;
    this.runner = createReplyRunner({
      readContext: (chatId) => store.readContext(chatId),
      contextIssue: (messages, model) => this.contextIssue(messages, model),
      reply,
      finish: (replyId, outcome) => store.finishReply(replyId, outcome),
      onStart: (run) =>
        this.publish({ pending: [...this.current.pending, run] }),
      onSettled: (run, update) => {
        if (update) this.apply(update);
        this.publish({
          pending: this.current.pending.filter(
            (pending) => pending.messageId !== run.messageId,
          ),
        });
      },
      onUnsaved: (unsaved) =>
        this.publish({
          unsavedReplies: [...this.current.unsavedReplies, unsaved],
        }),
    });
    this.state = createStore<ChatState>()(() => ({
      history: {
        chats: null,
        activeId: newChat.id,
        messages: [],
        selectedModel: newChat.selectedModel,
      },
      draft: this.createDraft(
        newChat.id,
        newChat.draft.text,
        newChat.draft.photos,
      ),
      saving: false,
      pending: [],
      unsavedReplies: [],
      chatsFailure: null,
      openFailure: null,
      error: null,
    }));
  }

  private get current() {
    return this.state.getState();
  }

  private publish(update: Partial<ChatState>) {
    this.state.setState(update);
  }

  // Updates the history list, and the workspace only when the result is
  // about the conversation it shows.
  private apply(update: ChatUpdate) {
    let history = this.current.history;
    if (update.seq > this.chatsSeq) {
      this.chatsSeq = update.seq;
      history = { ...history, chats: update.chats };
      this.publish({ chatsFailure: null });
    }
    if (
      update.chat.id === history.activeId &&
      update.seq > this.conversationSeq
    ) {
      this.conversationSeq = update.seq;
      history = {
        ...history,
        messages: update.chat.messages,
        selectedModel: update.chat.selectedModel,
      };
    }
    if (history !== this.current.history) this.publish({ history });
  }

  // The runner asks again with the context it actually read.
  private contextIssue(messages: PromptMessage[], model: string) {
    return inputIssue(messages, null, {
      audio: this.audioIssue(model),
      image: this.imageIssue(model),
    });
  }

  // Refuses a turn the open chat's model can't take before anything is saved.
  private turnIssue(model: string, outgoing: Outgoing) {
    return inputIssue(this.current.history.messages, outgoing, {
      audio: this.audioIssue(model),
      image: this.imageIssue(model),
    });
  }

  private createDraft(chatId: string, text: string, photos: PhotoAttachment[]) {
    return new PersistentDraft(
      ++this.draftKey,
      chatId,
      text,
      (value) => this.store.saveDraft(chatId, value),
      () => this.publish({ error: DRAFT_UNSAVED }),
      {
        initial: photos,
        read: () => this.store.readPhotoDraftData(chatId),
        add: (inputs) => this.store.addPhotoDraft(chatId, inputs),
        remove: (id) => this.store.removePhotoDraft(chatId, id),
      },
    );
  }

  readPhoto(reference: PhotoReference) {
    return this.store.readPhoto(reference);
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

  // Admission is reserved before persistence, so two callers cannot both
  // observe the chat idle. `accept` saves the turn for the open chat before
  // transport starts.
  private async start(
    { apiKey, model }: ReplySettings,
    accept: (chatId: string) => Promise<ChatUpdate & { replyId: number }>,
  ) {
    if (this.disposed || this.current.saving) return false;
    if (apiKey === null || !model.trim()) {
      this.publish({ error: "Connect OpenRouter in Settings first." });
      return false;
    }
    const { activeId } = this.current.history;
    if (this.current.unsavedReplies.some((reply) => reply.chatId === activeId))
      return this.reject(REPLY_UNSAVED);
    const admission = this.runner.admit(activeId);
    if (!admission) return false;
    this.publish({ saving: true, error: null });
    try {
      const update = await accept(activeId);
      if (this.disposed) {
        admission.release();
        return false;
      }
      this.apply(update);
      admission.start(update.replyId, { apiKey, model });
      return true;
    } catch {
      admission.release();
      this.publish({ error: "Couldn’t save that change. Please try again." });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  private reject(issue: string) {
    this.publish({ error: issue });
    return Promise.resolve(false);
  }

  send(text: string, photos: PhotoInput[]) {
    const settings = this.settingsForChat();
    const trimmed = text.trim();
    if (!trimmed && !photos.length) return Promise.resolve(false);
    if (photos.length) {
      try {
        validatePhotos(photos);
      } catch (cause) {
        return this.reject(
          cause instanceof Error ? cause.message : "Invalid photos.",
        );
      }
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH)
      return this.reject(
        `That message is too long. Please keep it under ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`,
      );
    const issue = this.turnIssue(settings.model, {
      kind: "text",
      text: trimmed,
      photos,
    });
    if (issue) return this.reject(issue);
    const draft = this.current.draft;
    return this.start(settings, async (chatId) => {
      const update = await this.store.beginReply(
        chatId,
        { kind: "text", text: trimmed, photos },
        settings.model,
        Date.now(),
      );
      if (photos.length) draft.consumePhotos();
      return update;
    });
  }

  sendAudio(audio: AudioInput) {
    const settings = this.settingsForChat();
    try {
      validateAudioPayload(audio);
    } catch (cause) {
      return this.reject(
        cause instanceof Error ? cause.message : "Invalid audio.",
      );
    }
    const issue = this.turnIssue(settings.model, { kind: "audio" });
    if (issue) return this.reject(issue);
    return this.start(settings, (chatId) =>
      this.store.beginReply(
        chatId,
        { kind: "audio", audio },
        settings.model,
        Date.now(),
      ),
    );
  }

  // The open chat's own model takes the place of the default.
  private settingsForChat(): ReplySettings {
    const settings = this.settings();
    return {
      ...settings,
      model: this.current.history.selectedModel ?? settings.model,
    };
  }

  // Saves the open chat's model. Resolves once it is saved and rejects with
  // the cause when it isn't; the caller shows the failure.
  async chooseModel(model: string) {
    if (this.disposed || this.current.saving)
      throw new Error("Another change is still being saved.");
    const chatId = this.current.history.activeId;
    this.publish({ saving: true, error: null });
    try {
      this.apply(await this.store.setSelectedModel(chatId, model));
    } finally {
      this.publish({ saving: false });
    }
  }

  retryReply(id: number) {
    const settings = this.settingsForChat();
    const issue = this.turnIssue(settings.model, null);
    if (issue) return this.reject(issue);
    return this.start(settings, () =>
      this.store.retryReply(id, settings.model, Date.now()),
    );
  }

  // Stops the open chat's reply.
  stop() {
    return this.runner.stop(this.current.history.activeId);
  }

  // Opens a chat; null opens the new chat. False when another save is in
  // progress or the read failed; a failed read keeps the current chat and is
  // published.
  async select(id: string | null) {
    if (this.disposed || this.current.saving) return false;
    const previous = this.current.draft;
    previous.suspended = true;
    this.publish({ saving: true, error: null, openFailure: null });
    // A failed draft save does not block navigation; the draft is kept.
    const kept = await previous.flush().then(
      () => false,
      () => true,
    );
    try {
      const workspace = await (id === null
        ? this.store.activateNew()
        : this.store.activate(id));
      if (kept) this.retained.set(previous.chatId, previous);
      else previous.close();
      this.open(workspace);
      if (kept && this.retained.get(previous.chatId) === previous)
        this.publish({
          error:
            "Couldn’t save the message you were typing in that chat. Leaving the app will lose it.",
        });
      return true;
    } catch (error) {
      previous.suspended = false;
      this.publish({
        openFailure: { id, error: error ?? new Error("Unknown failure.") },
      });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  // Lists the saved chats. Startup opens the new chat without waiting for
  // this; a newer list from any update supersedes the result.
  async loadChats() {
    if (this.disposed) return;
    try {
      const { seq, chats } = await this.store.readChats();
      if (this.disposed || seq <= this.chatsSeq) return;
      this.chatsSeq = seq;
      this.publish({
        history: { ...this.current.history, chats },
        chatsFailure: null,
      });
    } catch (cause) {
      if (!this.disposed)
        this.publish({ chatsFailure: cause ?? new Error("Unknown failure.") });
    }
  }

  dismissError() {
    this.publish({ error: null, openFailure: null });
  }

  private open(workspace: Workspace) {
    this.conversationSeq = workspace.seq;
    this.chatsSeq = Math.max(this.chatsSeq, workspace.seq);
    // Returning to a kept draft uses its newest edits, not older storage.
    const kept = this.retained.get(workspace.chat.id);
    if (kept) {
      this.retained.delete(workspace.chat.id);
      kept.suspended = false;
    }
    this.publish({
      history: {
        chats: workspace.chats,
        activeId: workspace.chat.id,
        messages: workspace.chat.messages,
        selectedModel: workspace.chat.selectedModel,
      },
      draft:
        kept ??
        this.createDraft(
          workspace.chat.id,
          workspace.draft.text,
          workspace.draft.photos,
        ),
      chatsFailure: null,
    });
  }

  // Settles a run in that chat first; its late result cannot recreate it.
  async remove(id: string) {
    if (this.disposed || this.current.saving) return false;
    this.publish({ saving: true, error: null });
    const previous = this.current.draft;
    const deletingCurrent = previous.chatId === id;
    if (deletingCurrent) previous.suspended = true;
    try {
      await this.runner.stop(id);
      const replacement = await this.store.remove(id);
      this.publish({
        unsavedReplies: this.current.unsavedReplies.filter(
          (reply) => reply.chatId !== id,
        ),
      });
      const kept = this.retained.get(id);
      if (kept) {
        kept.close();
        this.retained.delete(id);
      }
      if (deletingCurrent) {
        previous.close();
        this.open(replacement);
      } else if (replacement.seq > this.chatsSeq) {
        this.chatsSeq = replacement.seq;
        this.publish({
          history: { ...this.current.history, chats: replacement.chats },
          chatsFailure: null,
        });
      }
      return true;
    } catch {
      if (deletingCurrent) previous.suspended = false;
      this.publish({ error: "Couldn’t delete that chat. Please try again." });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  async dispose() {
    this.disposed = true;
    await this.runner.stopAll();
    await this.flushDraft();
    this.current.draft.close();
    for (const draft of this.retained.values()) {
      await draft.flush().catch(() => {});
      draft.close();
    }
    this.retained.clear();
  }
}
