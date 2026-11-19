import { toProviderContext } from "./context.ts";
import { StreamingText } from "./StreamingText.ts";
import type { PromptMessage, ReplyStatus } from "../storage/contracts";
import type { ChatUpdate, TerminalOutcome } from "../storage/repository";
import type {
  ReplyRequest,
  StreamReply,
} from "../../../providers/openrouter/transport";

export type PendingReply = {
  chatId: string;
  messageId: number;
  stream: StreamingText;
};
// A finished reply whose save failed: kept in memory for this session.
export type UnsavedReply = {
  chatId: string;
  messageId: number;
  outcome: TerminalOutcome;
  // Why the save failed.
  cause: unknown;
};
type Run = PendingReply & {
  abort: AbortController;
  startedAt: number;
  settled: Promise<void> | null;
};
type RunnerPorts = {
  readContext: (chatId: string) => Promise<PromptMessage[]>;
  // Checks the actual outgoing context, after it is read, before inference.
  contextIssue: (messages: PromptMessage[], model: string) => string | null;
  reply: StreamReply;
  // Applies a terminal result only while the reply is pending (see repository).
  finish: (
    replyId: number,
    outcome: TerminalOutcome,
  ) => Promise<ChatUpdate | null>;
  now: () => number;
  onStart: (run: PendingReply) => void;
  onSettled: (run: PendingReply, update: ChatUpdate | null) => void;
  onUnsaved: (unsaved: UnsavedReply) => void;
};
// A reservation taken before persistence: no second caller can observe the
// chat idle until its reply is started or released.
export type Admission = {
  start: (replyId: number, settings: ReplyRequest) => void;
  release: () => void;
};

// Owns the running replies, at most one per chat: admission, captured
// settings, stream, abort, elapsed time and the single terminal save.
export function createReplyRunner(ports: RunnerPorts) {
  // The chats being admitted and those replying.
  const reserved = new Set<string>();
  const active = new Map<string, Run>();
  const view = ({ chatId, messageId, stream }: Run): PendingReply => ({
    chatId,
    messageId,
    stream,
  });

  // The chat is idle again before anyone hears about the settled run.
  async function save(run: Run, outcome: TerminalOutcome) {
    try {
      const update = await ports.finish(run.messageId, outcome);
      active.delete(run.chatId);
      ports.onSettled(view(run), update);
    } catch (cause) {
      active.delete(run.chatId);
      ports.onUnsaved({
        chatId: run.chatId,
        messageId: run.messageId,
        outcome,
        cause,
      });
      ports.onSettled(view(run), null);
    }
  }

  // The first outcome wins; stop, failure and completion share one settle.
  function settle(
    run: Run,
    status: Exclude<ReplyStatus, "pending">,
    text: string,
    error: string | null,
    model: string | null,
  ) {
    run.settled ??= (async () => {
      run.stream.close();
      const elapsedMillis = Math.max(
        0,
        Math.round(ports.now() - run.startedAt),
      );
      await save(run, { status, text, error, model, elapsedMillis });
    })();
    return run.settled;
  }

  async function generate(run: Run, settings: ReplyRequest) {
    try {
      const messages = await ports.readContext(run.chatId);
      if (run.settled) return;
      const issue = ports.contextIssue(messages, settings.model);
      if (issue) throw new Error(issue);
      const completion = await ports.reply(
        toProviderContext(messages),
        settings,
        run.abort.signal,
        (text) => {
          if (!run.settled) run.stream.update(text);
        },
      );
      if (run.settled) return;
      // A reply cut short by a limit ends like one the user stopped.
      if (completion.stopped === null)
        await settle(run, "complete", completion.text, null, completion.model);
      else
        await settle(
          run,
          "cancelled",
          completion.text,
          completion.stopped === "length"
            ? "Reached the length limit."
            : "Timed out.",
          completion.model,
        );
      // Diagnostics contain usage metadata only, never credentials or prompts.
      console.info("AGSpeak OpenRouter completion", {
        model: completion.model,
        costUSD: completion.cost,
      });
    } catch (cause) {
      if (run.settled) return;
      await settle(
        run,
        "failed",
        run.stream.latest,
        cause instanceof Error ? cause.message : "The request failed.",
        null,
      );
    }
  }

  return {
    // Reserves a chat for one turn; null when it is already taking one.
    admit(chatId: string): Admission | null {
      if (reserved.has(chatId) || active.has(chatId)) return null;
      reserved.add(chatId);
      const startedAt = ports.now();
      let used = false;
      return {
        release() {
          if (used) return;
          used = true;
          reserved.delete(chatId);
        },
        start(replyId, settings) {
          if (used) return;
          used = true;
          reserved.delete(chatId);
          const run: Run = {
            chatId,
            messageId: replyId,
            stream: new StreamingText(),
            abort: new AbortController(),
            startedAt,
            settled: null,
          };
          active.set(run.chatId, run);
          ports.onStart(view(run));
          void generate(run, Object.freeze({ ...settings }));
        },
      };
    },
    // Stop-and-settle: resolves once that chat's stopped result is saved.
    stop(chatId: string): Promise<void> {
      const run = active.get(chatId);
      if (!run) return Promise.resolve();
      run.abort.abort();
      return settle(run, "cancelled", run.stream.latest, "Stopped.", null);
    },
    async stopAll() {
      await Promise.all([...active.keys()].map((chatId) => this.stop(chatId)));
    },
  };
}
export type ReplyRunner = ReturnType<typeof createReplyRunner>;
