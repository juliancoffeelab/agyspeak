import type { ChatHistory, HistoryStore } from './history';
import type { ModelSettings, ReplyFunction } from './openRouter';

export type PendingReply = { chatId: string; messageId: number };
export type ChatState = { history: ChatHistory; saving: boolean; pending: PendingReply | null; error: string | null };
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

  constructor(store: HistoryStore, history: ChatHistory, reply: ReplyFunction, createId: () => string) {
    this.store = store;
    this.reply = reply;
    this.createId = createId;
    this.state = { history, saving: false, pending: null, error: null };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(update: Partial<ChatState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
  }

  private write(action: () => Promise<ChatHistory>) {
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
      this.publish({ error: 'Couldn’t save that change. Please try again.' });
      return false;
    } finally { this.publish({ saving: false }); }
  }

  private async start(settings: ModelSettings, action: () => Promise<ChatHistory>) {
    if (this.disposed || this.state.saving || this.active) return false;
    if (!settings.apiKey.trim() || !settings.model.trim()) {
      this.publish({ error: 'Connect OpenRouter in Settings first.' });
      return false;
    }
    if (!await this.change(action) || this.disposed) return false;
    const { history } = this.state;
    const pending = history.messages.at(-1);
    if (!history.activeId || pending?.status !== 'pending') return false;
    const run: Run = { chatId: history.activeId, messageId: pending.id, abort: new AbortController() };
    this.active = run;
    this.publish({ pending: { chatId: run.chatId, messageId: run.messageId } });
    void this.generate(run, history, settings);
    return true;
  }

  send(text: string, settings: ModelSettings) {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve(false);
    if (trimmed.length > 12_000) {
      this.publish({ error: 'That message is too long. Please keep it under 12,000 characters.' });
      return Promise.resolve(false);
    }
    const id = this.state.history.activeId ?? this.createId();
    return this.start(settings, () => this.store.beginReply(id, trimmed, settings.model, Date.now()));
  }

  retryReply(id: number, settings: ModelSettings) {
    return this.start(settings, () => this.store.retryReply(id, settings.model, Date.now()));
  }

  private async generate(run: Run, history: ChatHistory, settings: ModelSettings) {
    try {
      const completion = await this.reply(history.messages, settings, run.abort.signal);
      if (this.active !== run || run.abort.signal.aborted) return;
      const saved = await this.write(() => this.store.finishReply(run.messageId, 'complete', completion.text, null, completion.model));
      if (this.active !== run) return;
      this.active = null;
      this.publish({ history: saved, pending: null });
      // Diagnostics contain usage metadata only, never credentials or prompts.
      console.info('AGSpeak OpenRouter completion', { model: completion.model, costUSD: completion.cost });
    } catch (cause) {
      if (this.active !== run) return;
      const error = cause instanceof Error ? cause.message : 'The request failed. You can retry it.';
      try {
        const saved = await this.write(() => this.store.finishReply(run.messageId, 'failed', '', error));
        if (this.active !== run) return;
        this.active = null;
        this.publish({ history: saved, pending: null });
      } catch {
        this.active = null;
        this.publish({ pending: null, error: 'Couldn’t save the reply state. Reopen the chat before retrying.' });
      }
    }
  }

  async stop() {
    const run = this.active;
    if (!run) return;
    this.active = null;
    run.abort.abort();
    this.publish({ pending: null });
    try {
      this.publish({ history: await this.write(() => this.store.finishReply(run.messageId, 'cancelled', '', 'Stopped. You can retry this reply.')) });
    } catch {
      this.publish({ error: 'Couldn’t save the stopped reply. Reopen the chat before retrying.' });
    }
  }

  select(id: string | null) { return this.change(() => this.store.select(id)); }

  async remove(id: string) {
    if (this.active?.chatId === id) await this.stop();
    return this.change(() => this.store.remove(id));
  }

  async dispose() {
    this.disposed = true;
    this.listeners.clear();
    await this.stop();
    await this.writes;
  }
}
