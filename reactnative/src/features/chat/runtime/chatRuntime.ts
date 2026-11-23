import { createStore, type StoreApi } from "zustand/vanilla";

import {
  refusal,
  step,
  type Chat,
  type Effect,
  type Event,
} from "./machine.ts";
import type { Entry, RequestMessage, UserEntry } from "./log.ts";
import { StreamingText } from "./StreamingText.ts";
import type { ChatList } from "../storage/repository.ts";
import {
  ProviderError,
  type ProviderMessage,
  type StreamReply,
} from "../../../providers/openrouter/transport.ts";

// Carries out one chat's effects and steps its machine with what they
// return. It holds no rules of its own: whether something may happen, and
// what follows it, is the machine's.

export const NOT_CONNECTED = "Connect OpenRouter in Settings first.";

export type RuntimePorts = {
  // The key requests are made with, null while none is connected.
  apiKey: () => string | null;
  reply: StreamReply;
  readMedia: (keys: readonly string[]) => Promise<Map<string, string>>;
  // Writes the log as a write effect says, taking `sent` from the draft
  // in the same transaction.
  writeLog: (
    keep: number,
    entries: readonly Entry[],
    sent: UserEntry | null,
    model: string,
    now: number,
  ) => Promise<ChatList>;
  // A write's result: the list of chats as it left it.
  onList: (list: ChatList) => void;
  // A message sent from the chat, now saved.
  onSaved: (message: UserEntry) => void;
  // A message the chat gives back to be edited.
  onReturned: (message: UserEntry) => void;
  now: () => number;
};

// Whole milliseconds since `sent`, on the monotonic clock.
const since = (sent: number) => Math.round(performance.now() - sent);

// What the runtime is asked: the machine's events, a stop without how long
// the reply has run, which the runtime measures.
export type Input = Exclude<Event, { kind: "stop" }> | { kind: "stop" };

// What the screen reads of a chat: the machine's state, the text of the
// reply being written as it is shown, and the thumbnails of its photos.
export type ChatView = {
  id: string;
  chat: Chat;
  stream: StreamingText | null;
  thumbnails: Readonly<Record<string, string>>;
};

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// The provider messages of `messages`, their media read from storage.
export async function providerMessages(
  messages: readonly RequestMessage[],
  readMedia: RuntimePorts["readMedia"],
): Promise<ProviderMessage[]> {
  const keys = messages.flatMap((message) => [
    ...(message.audio ? [message.audio.key] : []),
    ...(message.photos ?? []).map((photo) => photo.key),
  ]);
  const media = keys.length ? await readMedia(keys) : new Map<string, string>();
  const bytes = (key: string) => {
    const data = media.get(key);
    if (data === undefined) throw new Error(`Media ${key} wasn’t read.`);
    return data;
  };
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.audio
      ? {
          audio: {
            data: bytes(message.audio.key),
            format: message.audio.format,
          },
        }
      : {}),
    ...(message.photos?.length
      ? { photos: message.photos.map((photo) => ({ data: bytes(photo.key) })) }
      : {}),
  }));
}

export class ChatRuntime {
  readonly view: StoreApi<ChatView>;
  private readonly ports: RuntimePorts;
  private readonly aborts = new Map<number, AbortController>();
  // When each reply request in flight was sent, on the monotonic clock.
  private readonly replies = new Map<number, number>();
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    id: string,
    chat: Chat,
    thumbnails: Record<string, string>,
    ports: RuntimePorts,
  ) {
    this.ports = ports;
    this.view = createStore<ChatView>()(() => ({
      id,
      chat,
      stream: null,
      thumbnails,
    }));
  }

  get chat() {
    return this.view.getState().chat;
  }

  // Thumbnails of photos saved for a message about to be sent.
  addThumbnails(thumbnails: Record<string, string>) {
    this.view.setState({
      thumbnails: { ...this.view.getState().thumbnails, ...thumbnails },
    });
  }

  // Steps the machine with `event` and carries out what it asks; the
  // refusal, or null when the event was taken.
  dispatch(input: Input): string | null {
    if (this.disposed) return "This chat is closed.";
    const event: Event =
      input.kind === "stop"
        ? { kind: "stop", elapsedMillis: this.replyElapsed() }
        : input;
    const outcome = step(this.chat, event, this.ports.now());
    if (outcome.refused !== null) return outcome.refused;
    // A chunk changes only the text being written, which its stream shows.
    if (event.kind === "chunk") this.view.getState().chat = outcome.chat;
    else this.view.setState({ chat: outcome.chat });
    for (const effect of outcome.effects) this.carryOut(effect);
    return null;
  }

  // How long the reply being written has had its request in flight; null
  // when it isn't sent (it waits for a write) or none is being written.
  private replyElapsed(): number | null {
    const { phase } = this.chat;
    const sent =
      phase.kind === "writing" ? this.replies.get(phase.reply.request) : null;
    return sent == null ? null : since(sent);
  }

  private carryOut(effect: Effect) {
    if (effect.kind === "return") this.ports.onReturned(effect.message);
    else if (effect.kind === "abort") {
      this.aborts.get(effect.id)?.abort();
      this.aborts.delete(effect.id);
      this.replies.delete(effect.id);
      this.closeStream();
    } else if (effect.kind === "write") {
      const now = this.ports.now();
      const model = this.chat.model.id;
      this.writing = this.ports
        .writeLog(effect.keep, effect.entries, effect.sent, model, now)
        .then(
          (list) => {
            if (this.disposed) return;
            this.ports.onList(list);
            this.dispatch({ kind: "saved" });
            if (effect.sent) this.ports.onSaved(effect.sent);
          },
          (cause: unknown) => {
            if (this.disposed) return;
            console.error("Couldn’t save the chat.", cause);
            this.dispatch({ kind: "save-failed", cause });
          },
        );
    } else void this.request(effect);
  }

  private async request(effect: Extract<Effect, { kind: "request" }>) {
    const abort = new AbortController();
    this.aborts.set(effect.id, abort);
    const sent = performance.now();
    if (effect.purpose === "reply") this.replies.set(effect.id, sent);
    const stream = effect.purpose === "reply" ? new StreamingText() : null;
    if (stream) {
      this.closeStream();
      this.view.setState({ stream });
    }
    try {
      const apiKey = this.ports.apiKey();
      if (apiKey === null) throw new Error(NOT_CONNECTED);
      const messages = await providerMessages(
        effect.messages,
        this.ports.readMedia,
      );
      if (abort.signal.aborted) return;
      const completion = await this.ports.reply(
        messages,
        {
          apiKey,
          model: effect.model,
          sessionId: this.view.getState().id,
          maxTokens: effect.maxTokens,
        },
        abort.signal,
        (text) => {
          stream?.update(text);
          this.dispatch({ kind: "chunk", request: effect.id, text });
        },
      );
      console.info(
        `OpenRouter ${effect.purpose} by ${completion.model}`,
        completion.usage,
      );
      this.finish(stream);
      this.dispatch({
        kind: "completed",
        request: effect.id,
        completion,
        elapsedMillis: since(sent),
      });
    } catch (cause) {
      this.finish(stream);
      // A stopped request was settled by the machine when it was stopped.
      if (abort.signal.aborted || this.disposed) return;
      console.error(`OpenRouter ${effect.purpose} failed.`, cause);
      this.dispatch({
        kind: "request-failed",
        request: effect.id,
        error: errorText(cause),
        providerError:
          cause instanceof ProviderError
            ? { message: cause.providerMessage }
            : null,
        cause,
        elapsedMillis: since(sent),
      });
    } finally {
      this.aborts.delete(effect.id);
      this.replies.delete(effect.id);
    }
  }

  private finish(stream: StreamingText | null) {
    if (stream !== null && this.view.getState().stream === stream)
      this.closeStream();
  }
  private closeStream() {
    const { stream } = this.view.getState();
    if (stream === null) return;
    stream.close();
    this.view.setState({ stream: null });
  }

  // Stops what runs, and resolves once what that wrote is saved or failed.
  async settle() {
    if (refusal(this.chat, "stop") === null) this.dispatch({ kind: "stop" });
    let writing;
    do {
      writing = this.writing;
      await writing;
    } while (writing !== this.writing);
  }

  // Stops every request and waits for the write in flight.
  async dispose() {
    this.disposed = true;
    for (const abort of this.aborts.values()) abort.abort();
    this.aborts.clear();
    this.closeStream();
    await this.writing;
  }
}
