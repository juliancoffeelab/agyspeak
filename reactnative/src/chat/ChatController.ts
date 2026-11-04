import { PersistentDraft } from "./PersistentDraft.ts";
import { StreamingText } from "./StreamingText.ts";
import type { AudioInput, ChatHistory, HistoryStore } from "./history";
import {
  validateAudio,
  type ModelSettings,
  type ReplyFunction,
} from "./openRouter.ts";

export type PendingReply = {
  chatId: string;
  messageId: number;
  stream: StreamingText;
};
export type ChatState = {
  history: ChatHistory;
  draft: PersistentDraft;
  saving: boolean;
  pending: PendingReply | null;
  error: string | null;
};
type Run = PendingReply & { abort: AbortController };

export class ChatController {
  private readonly store: HistoryStore;
  private readonly reply: ReplyFunction;
  private readonly createId: () => string;
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private active: Run | null = null;
  private disposed = false;
  private draftKey = 0;

  constructor(
    store: HistoryStore,
    history: ChatHistory,
    reply: ReplyFunction,
    createId: () => string,
    initialDraft: string,
  ) {
    this.store = store;
    this.reply = reply;
    this.createId = createId;
    this.state = {
      history,
      draft: this.createDraft(history.activeId, initialDraft),
      saving: false,
      pending: null,
      error: null,
    };
  }

  private createDraft(chatId: string | null, text: string) {
    const draft: PersistentDraft = new PersistentDraft(
      ++this.draftKey,
      chatId,
      text,
      (value) => this.write(() => this.store.saveDraft(draft.chatId, value)),
      () =>
        this.publish({
          error: "Couldn’t save your draft. Try leaving the chat again.",
        }),
    );
    return draft;
  }

  async flushDraft() {
    try {
      await this.state.draft.flush();
      return true;
    } catch {
      this.publish({ error: "Couldn’t save your draft. Please try again." });
      return false;
    }
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(update: Partial<ChatState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }

  private write<T>(action: () => Promise<T>) {
    const result = this.writes.then(action);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async change(action: () => Promise<ChatHistory>) {
    if (this.disposed || this.state.saving) return false;
    this.publish({ saving: true, error: null });
    try {
      this.publish({ history: await this.write(action) });
      return true;
    } catch {
      this.publish({ error: "Couldn’t save that change. Please try again." });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  private async start(
    settings: ModelSettings,
    action: () => Promise<ChatHistory>,
  ) {
    if (this.disposed || this.state.saving || this.active) return false;
    if (!settings.apiKey.trim() || !settings.model.trim()) {
      this.publish({ error: "Connect OpenRouter in Settings first." });
      return false;
    }
    if (!(await this.change(action)) || this.disposed) return false;
    const { history } = this.state;
    const pending = history.messages.at(-1);
    if (!history.activeId || pending?.status !== "pending") return false;
    const run: Run = {
      chatId: history.activeId,
      messageId: pending.id,
      abort: new AbortController(),
      stream: new StreamingText(),
    };
    this.active = run;
    this.publish({
      pending: {
        chatId: run.chatId,
        messageId: run.messageId,
        stream: run.stream,
      },
    });
    void this.generate(run, settings);
    return true;
  }

  send(text: string, settings: ModelSettings) {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve(false);
    if (trimmed.length > 12_000) {
      this.publish({
        error:
          "That message is too long. Please keep it under 12,000 characters.",
      });
      return Promise.resolve(false);
    }
    const id = this.state.history.activeId ?? this.createId();
    const draft = this.state.draft;
    return this.start(settings, async () => {
      const history = await this.store.beginReply(
        id,
        trimmed,
        settings.model,
        Date.now(),
      );
      draft.chatId = id;
      return history;
    });
  }

  sendAudio(audio: AudioInput, settings: ModelSettings) {
    try {
      validateAudio(audio);
    } catch (cause) {
      this.publish({
        error: cause instanceof Error ? cause.message : "Invalid audio.",
      });
      return Promise.resolve(false);
    }
    const id = this.state.history.activeId ?? this.createId();
    const draft = this.state.draft;
    return this.start(settings, async () => {
      const history = await this.store.beginReply(
        id,
        "Voice message",
        settings.model,
        Date.now(),
        audio,
      );
      draft.chatId = id;
      return history;
    });
  }

  retryReply(id: number, settings: ModelSettings) {
    return this.start(settings, () =>
      this.store.retryReply(id, settings.model, Date.now()),
    );
  }

  private async generate(run: Run, settings: ModelSettings) {
    try {
      const messages = await this.write(() =>
        this.store.readContext(run.chatId),
      );
      if (this.active !== run || run.abort.signal.aborted) return;
      const completion = await this.reply(
        messages,
        settings,
        run.abort.signal,
        (text) => {
          if (this.active === run && !run.abort.signal.aborted)
            run.stream.update(text);
        },
      );
      if (this.active !== run || run.abort.signal.aborted) return;
      const saved = await this.write(() =>
        this.store.finishReply(
          run.messageId,
          "complete",
          completion.text,
          null,
          completion.model,
        ),
      );
      if (this.active !== run) return;
      run.stream.close();
      this.active = null;
      this.publish({ history: saved, pending: null });
      // Diagnostics contain usage metadata only, never credentials or prompts.
      console.info("AGSpeak OpenRouter completion", {
        model: completion.model,
        costUSD: completion.cost,
      });
    } catch (cause) {
      if (this.active !== run) return;
      run.stream.close();
      const error =
        cause instanceof Error
          ? cause.message
          : "The request failed. You can retry it.";
      try {
        const saved = await this.write(() =>
          this.store.finishReply(
            run.messageId,
            "failed",
            run.stream.latest,
            error,
          ),
        );
        if (this.active !== run) return;
        this.active = null;
        this.publish({ history: saved, pending: null });
      } catch {
        this.active = null;
        this.publish({
          pending: null,
          error:
            "Couldn’t save the reply state. Reopen the chat before retrying.",
        });
      }
    }
  }

  async stop() {
    const run = this.active;
    if (!run) return;
    this.active = null;
    run.abort.abort();
    run.stream.close();
    try {
      this.publish({
        pending: null,
        history: await this.write(() =>
          this.store.finishReply(
            run.messageId,
            "cancelled",
            run.stream.latest,
            "Stopped. You can retry this reply.",
          ),
        ),
      });
    } catch {
      this.publish({
        pending: null,
        error:
          "Couldn’t save the stopped reply. Reopen the chat before retrying.",
      });
    }
  }

  async select(id: string | null) {
    if (this.disposed || this.state.saving) return false;
    const previous = this.state.draft;
    previous.suspended = true;
    this.publish({ saving: true, error: null });
    try {
      await previous.flush();
      const next = await this.write(async () => {
        const text = await this.store.readDraft(id);
        return {
          history: await this.store.select(id),
          draft: this.createDraft(id, text),
        };
      });
      previous.close();
      this.publish(next);
      return true;
    } catch {
      previous.suspended = false;
      this.publish({
        error: "Couldn’t switch chats or save your draft. Please try again.",
      });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  async remove(id: string) {
    if (this.disposed || this.state.saving) return false;
    if (this.active?.chatId === id) await this.stop();
    const previous = this.state.draft;
    const deletingCurrent = previous.chatId === id;
    if (deletingCurrent) previous.suspended = true;
    this.publish({ saving: true, error: null });
    try {
      const next = await this.write(async () => {
        const text = deletingCurrent ? await this.store.readDraft(null) : "";
        const history = await this.store.remove(id);
        return {
          history,
          draft: deletingCurrent ? this.createDraft(null, text) : previous,
        };
      });
      if (deletingCurrent) previous.close();
      this.publish(next);
      return true;
    } catch {
      previous.suspended = false;
      this.publish({ error: "Couldn’t delete that chat. Please try again." });
      return false;
    } finally {
      this.publish({ saving: false });
    }
  }

  async dispose() {
    this.disposed = true;
    this.listeners.clear();
    await this.stop();
    await this.flushDraft();
    this.state.draft.close();
    await this.writes;
  }
}
