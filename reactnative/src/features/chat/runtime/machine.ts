import { cleanBreak } from "./breaks.ts";
import {
  COMPACTION_CUT_OFF,
  CONTEXT_TOO_SMALL,
  CUT_OFF,
  MAX_CONTINUATIONS,
  MESSAGE_TOO_LONG,
  messageEstimate,
  NO_ROOM,
  RECORDING_TOO_LONG,
} from "./compaction.ts";
import {
  budgetOf,
  compactionDue,
  compactionPlan,
  contextRefusal,
  logIssue,
  prepareReply,
  replyMediaRefusal,
  replyParts,
  roomRefusal,
  type AudioRef,
  type Bound,
  type CompactionEntry,
  type Ending,
  type Entry,
  type Log,
  type ModelFacts,
  type PhotoRef,
  type Plan,
  type Refusal,
  type ReplyEntry,
  type RequestMessage,
  type UserEntry,
} from "./log.ts";
import type { Completion } from "../../../providers/openrouter/transport.ts";

// One chat's state as a pure machine: `step(chat, event, now)` returns the
// next state and the effects to carry out, which a runtime executes and
// answers with results. Nothing here touches a provider, storage, clock or
// timer: `now` is when the event happened, as the runtime read it, and how
// long a request took comes with the event that ends it.

// A reply's request in flight: what it has written so far, what it was
// allowed and which limit that was, the compaction it began from, and what
// the reply's earlier requests wrote and how many continuations it took.
export type Writing = {
  request: number;
  text: string;
  maxTokens: number;
  bound: Bound;
  compaction: number | null;
  spent: number;
  continuations: number;
};
// A compaction's request in flight, and the index its entry takes.
export type Compacting = { request: number; plan: Plan; at: number };
// A reply to continue once it is compacted: its part cut at the cut line,
// or null when its last part is in the log (continued by hand), and the
// passes made for it so far. They are written together once the final
// pass arrives, or with the part ended where it was cut when none does.
export type Cut = {
  part: ReplyEntry | null;
  passes: CompactionEntry[];
  spent: number;
  continuations: number;
};
export type Phase =
  | { kind: "ready" }
  // A message waiting on the compaction that makes room for it. It goes
  // after the log's first `base` entries: all of them for a new message, or
  // those before it for one retried, which stays where it is in the log
  // until it is sent again. `passes` are the compactions made for it so
  // far, written with it. `retry` is set for a retried message. `adopted`
  // is set while the compaction running is the one the chat was making
  // when the message was sent, planned for the chat rather than for it.
  | {
      kind: "making-room";
      message: UserEntry;
      base: number;
      passes: CompactionEntry[];
      retry: boolean;
      incoming: number;
      adopted: boolean;
      compaction: Compacting;
    }
  | { kind: "writing"; reply: Writing }
  // Compacting after a reply or when asked; a message sent meanwhile waits
  // for it (see `making-room`).
  | { kind: "compacting"; why: "due" | "asked"; compaction: Compacting }
  // Compacting to continue a reply.
  | { kind: "continuing"; compaction: Compacting; cut: Cut }
  // The last reply failed: `fault` is why, null when that isn't known, as
  // in a chat opened failed.
  | { kind: "failed"; fault: Fault | null }
  // `fault` is why it failed; `blocked` is why the same compaction would
  // fail the same way until the model changes, null when compacting again
  // may succeed.
  | { kind: "compaction-failed"; fault: Fault; blocked: Refusal | null }
  // A write failed: `resume` is the phase it interrupted, and `then` the
  // effects that were waiting for it.
  | { kind: "unsaved"; cause: unknown; resume: Phase; then: Effect[] };

// Why a reply or a compaction failed: the error its request met, or what
// it was refused for, with the facts that was decided from. It is kept in
// memory only: a saved reply keeps its ending's code.
export type Fault =
  | { kind: "thrown"; reason: string; cause: unknown }
  | { kind: "refused"; refusal: Refusal };
// A compaction failed for a refusal: one the same compaction meets again.
const blockedBy = (refusal: Refusal): Phase => ({
  kind: "compaction-failed",
  fault: { kind: "refused", refusal },
  blocked: refusal,
});
export const faultReason = (fault: Fault) =>
  fault.kind === "thrown" ? fault.reason : fault.refusal.reason;

export type RequestEffect = {
  kind: "request";
  id: number;
  purpose: "reply" | "summary";
  model: string;
  messages: RequestMessage[];
  maxTokens: number;
};
// The saved log becomes its first `keep` entries, then `entries`; a write
// is atomic. `sent` is the message sent from the chat that the write saves
// first, among `entries`: the write takes it from the draft, which holds
// it until then. Null when the write saves no new message.
export type WriteEffect = {
  kind: "write";
  keep: number;
  entries: Entry[];
  sent: UserEntry | null;
};
// A message that won't be sent, or was discarded, given back to be edited.
export type ReturnEffect = { kind: "return"; message: UserEntry };
export type Effect =
  RequestEffect | WriteEffect | ReturnEffect | { kind: "abort"; id: number };

export type Command =
  | { kind: "send"; text: string; photos: PhotoRef[] }
  | { kind: "send-recording"; audio: AudioRef }
  | { kind: "retry" }
  | { kind: "continue" }
  | { kind: "compact" }
  | { kind: "change-model"; model: ModelFacts }
  // `elapsedMillis` is how long the reply request in flight has run, as the
  // runtime measured it; null when none is in flight.
  | { kind: "stop"; elapsedMillis: number | null }
  | { kind: "discard" }
  | { kind: "save-again" };
export type CommandKind = Command["kind"];
export type Result =
  // The text request `request` has written so far.
  | { kind: "chunk"; request: number; text: string }
  // How long each request took, as the runtime measured it.
  | {
      kind: "completed";
      request: number;
      completion: Completion;
      elapsedMillis: number;
    }
  // `error` is what was thrown, as it reads; `providerError` is set when
  // the provider answered with an error, with its own message, if any.
  | {
      kind: "request-failed";
      request: number;
      error: string;
      providerError: { message: string | null } | null;
      cause: unknown;
      elapsedMillis: number;
    }
  | { kind: "saved" }
  | { kind: "save-failed"; cause: unknown }
  // What is known about the chat's model changed, as when the catalog is
  // refreshed or an alias moves.
  | { kind: "capabilities"; model: ModelFacts };
export type Event = Command | Result;

export type Chat = {
  log: Log;
  // The log as it is saved, as far as writes have succeeded.
  store: Log;
  phase: Phase;
  model: ModelFacts;
  // Requests made so far; each gets the next number.
  requests: number;
  // A write in flight, and the effects that wait for it.
  saving: { write: WriteEffect; then: Effect[] } | null;
  // When the event being stepped happened, in epoch milliseconds.
  now: number;
};
export type Outcome = { chat: Chat; effects: Effect[]; refused: string | null };

// What the screen says for each ending.
export const ENDINGS: Record<Ending, string> = {
  stopped: "Stopped.",
  length: "Reached the length limit.",
  "reply-limit": "Reached the length limit.",
  "cut-off": CUT_OFF,
  timeout: "Timed out.",
  empty: "The model wrote nothing.",
  "no-compaction": COMPACTION_CUT_OFF,
  "no-room": NO_ROOM,
  "too-small": CONTEXT_TOO_SMALL,
  "unsupported-input":
    "This model can’t take the photos or recordings in this conversation.",
  "not-compacted":
    "The conversation couldn’t be compacted to make room for the message.",
  "request-failed": "The request failed.",
  "provider-error": "OpenRouter answered with an error.",
  closed: "The app closed before this reply finished.",
};
export const MODEL_IN_USE =
  "The model can’t be changed while this chat is replying or compacting.";
export const WRITING = "A reply is being written.";
export const MAKING_ROOM =
  "The conversation is being compacted to make room for a message.";
export const COMPACTING = "The conversation is being compacted.";
export const CONTINUING =
  "The conversation is being compacted to continue the reply.";
export const LAST_FAILED = "The last reply failed: retry or discard it.";
export const NOT_COMPACTED =
  "The conversation couldn’t be compacted: compact it again or choose another model.";
export const UNSAVED =
  "Part of this chat couldn’t be saved: save it again to go on.";
export const NOTHING_RUNNING = "Nothing is running in this chat.";
export const ONLY_FAILED = "Only a failed reply can be discarded.";
export const ALL_SAVED = "Everything in this chat is saved.";
export const NOTHING_TO_RETRY = "There’s no reply to retry.";
export const NOT_CUT_OFF =
  "Only a reply cut off at its length limit can be continued.";
export const NOTHING_TO_COMPACT = "There’s nothing to compact yet.";
export const EMPTY_MESSAGE = "Write a message or add a photo first.";

// The commands each phase takes.
export const COMMANDS: Record<Phase["kind"], readonly CommandKind[]> = {
  ready: [
    "send",
    "send-recording",
    "retry",
    "continue",
    "compact",
    "change-model",
  ],
  "making-room": ["stop"],
  writing: ["stop"],
  // A message sent while the chat compacts waits for the compaction.
  compacting: ["send", "send-recording", "stop"],
  continuing: ["stop"],
  failed: ["retry", "change-model", "discard"],
  "compaction-failed": ["compact", "change-model"],
  unsaved: ["save-again"],
};

const CONTINUABLE: readonly Ending[] = [
  "cut-off",
  "reply-limit",
  "no-compaction",
];
// Whether the log's last reply stopped at a limit and can go on: a
// compaction made after it doesn't change that.
function continuable(log: Log): boolean {
  const last = log.findLast((entry) => entry.kind !== "compaction");
  return (
    last?.kind === "reply" &&
    last.status === "stopped" &&
    last.ending !== null &&
    CONTINUABLE.includes(last.ending)
  );
}

function phaseReason(phase: Phase, kind: CommandKind): string {
  if (kind === "save-again") return ALL_SAVED;
  if (phase.kind === "unsaved") return UNSAVED;
  if (kind === "stop") return NOTHING_RUNNING;
  if (
    phase.kind === "making-room" ||
    phase.kind === "writing" ||
    phase.kind === "compacting" ||
    phase.kind === "continuing"
  ) {
    if (kind === "change-model") return MODEL_IN_USE;
    return {
      "making-room": MAKING_ROOM,
      writing: WRITING,
      compacting: COMPACTING,
      continuing: CONTINUING,
    }[phase.kind];
  }
  if (kind === "discard") return ONLY_FAILED;
  if (phase.kind === "failed") return LAST_FAILED;
  if (phase.kind === "compaction-failed")
    return phase.blocked?.reason ?? NOT_COMPACTED;
  // Ready takes every other command.
  return LAST_FAILED;
}

// Whether the chat takes a command of `kind` now, and if not, why. A
// command it takes may still be refused for what it carries (a message too
// long, say), but never for the phase.
export function refusal(chat: Chat, kind: CommandKind): string | null {
  const { phase, log } = chat;
  if (!COMMANDS[phase.kind].includes(kind)) return phaseReason(phase, kind);
  if (
    kind === "retry" &&
    phase.kind === "ready" &&
    replyParts(log).length === 0
  )
    return NOTHING_TO_RETRY;
  if (kind === "continue") {
    if (!continuable(log)) return NOT_CUT_OFF;
    const plan = compactionPlan(log, chat.model, { kind: "continue" });
    if (plan === null) return NO_ROOM;
    if (plan.blocked) return plan.blocked.reason;
  }
  if (kind === "compact" && phase.kind === "compaction-failed" && phase.blocked)
    return phase.blocked.reason;
  return null;
}

// A chat opened from a saved log, which must be one this code works with.
export function openChat(log: Log, model: ModelFacts, now: number): Chat {
  const issue = logIssue(log);
  if (issue) throw new Error(`This chat can’t be opened: ${issue}`);
  return {
    log,
    store: log,
    phase: settledPhase(log),
    model,
    requests: 0,
    saving: null,
    now,
  };
}

// The phase a log is in when nothing runs: failed when its last reply
// failed or never arrived (the app closed while it was written).
function settledPhase(log: Log): Phase {
  const last = log.at(-1);
  return (last?.kind === "reply" && last.status === "failed") ||
    last?.kind === "user" ||
    (last?.kind === "compaction" && last.instruction !== null)
    ? { kind: "failed", fault: null }
    : { kind: "ready" };
}

const unchanged = (chat: Chat): Outcome => ({
  chat,
  effects: [],
  refused: null,
});
const refuse = (chat: Chat, reason: string): Outcome => ({
  chat,
  effects: [],
  refused: reason,
});

// Effects are released up to the first write; what follows waits for it.
function release(chat: Chat, effects: Effect[]): Outcome {
  if (chat.saving !== null)
    return unchanged({
      ...chat,
      saving: { ...chat.saving, then: [...chat.saving.then, ...effects] },
    });
  const index = effects.findIndex((effect) => effect.kind === "write");
  if (index === -1) return { chat, effects, refused: null };
  return {
    chat: {
      ...chat,
      saving: {
        write: effects[index] as WriteEffect,
        then: effects.slice(index + 1),
      },
    },
    effects: effects.slice(0, index + 1),
    refused: null,
  };
}

function shared(a: Log, b: Log): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}

// The write that makes `from` into `to` from its first `keep` entries. A
// message `from` doesn't hold is one sent, and at most one is unsaved.
function writeOf(from: Log, to: Log, keep: number): WriteEffect {
  const entries = to.slice(keep);
  const sent = entries.find(
    (entry): entry is UserEntry =>
      entry.kind === "user" && !from.includes(entry),
  );
  return { kind: "write", keep, entries, sent: sent ?? null };
}

// Moves the chat to `log` and `phase`, writing what changed first.
function go(chat: Chat, log: Log, phase: Phase, effects: Effect[]): Outcome {
  const keep = shared(chat.log, log);
  const write: Effect[] =
    keep === chat.log.length && keep === log.length
      ? []
      : [writeOf(chat.log, log, keep)];
  return release({ ...chat, log, phase }, [...write, ...effects]);
}

function request(
  chat: Chat,
  purpose: RequestEffect["purpose"],
  messages: RequestMessage[],
  maxTokens: number,
): { chat: Chat; effect: RequestEffect } {
  const id = chat.requests + 1;
  return {
    chat: { ...chat, requests: id },
    effect: {
      kind: "request",
      id,
      purpose,
      model: chat.model.id,
      messages,
      maxTokens,
    },
  };
}

// A part that failed now; `elapsedMillis` is how long its request ran, null
// when none was sent.
function failedPart(
  chat: Chat,
  elapsedMillis: number | null,
  text: string,
  ending: Ending,
  providerMessage: string | null,
): ReplyEntry {
  return {
    kind: "reply",
    status: "failed",
    text,
    ending,
    providerMessage,
    model: null,
    usage: null,
    maxTokens: null,
    compaction: null,
    postedAt: chat.now,
    elapsedMillis,
  };
}

// The reply's next request, or a failed part saying why it can't be sent.
function startReply(
  chat: Chat,
  log: Log,
  spent: number,
  continuations: number,
): Outcome {
  const prepared = prepareReply(log, chat.model, spent);
  if ("issue" in prepared)
    return go(
      chat,
      [...log, failedPart(chat, null, "", prepared.ending, null)],
      { kind: "failed", fault: { kind: "refused", refusal: prepared.issue } },
      [],
    );
  const made = request(chat, "reply", prepared.messages, prepared.maxTokens);
  return go(
    made.chat,
    log,
    {
      kind: "writing",
      reply: {
        request: made.effect.id,
        text: "",
        maxTokens: prepared.maxTokens,
        bound: prepared.bound,
        compaction: prepared.compaction,
        spent,
        continuations,
      },
    },
    [made.effect],
  );
}

function compaction(chat: Chat, plan: Plan, at: number) {
  const made = request(chat, "summary", plan.messages, plan.maxTokens);
  return {
    chat: made.chat,
    effect: made.effect,
    compacting: { request: made.effect.id, plan, at },
  };
}

// After a reply ends complete or stopped: compacted when it left the chat
// past the threshold.
function afterReply(chat: Chat, log: Log): Outcome {
  const plan = compactionPlan(log, chat.model, { kind: "reply" });
  if (plan === null) return go(chat, log, { kind: "ready" }, []);
  if (plan.blocked) return go(chat, log, blockedBy(plan.blocked), []);
  const made = compaction(chat, plan, log.length);
  return go(
    made.chat,
    log,
    { kind: "compacting", why: "due", compaction: made.compacting },
    [made.effect],
  );
}

// A reply ends with `part`; when it failed, `facts` are what it ended on.
function endReply(
  chat: Chat,
  log: Log,
  part: ReplyEntry,
  facts: Refusal["facts"],
): Outcome {
  const next = [...log, part];
  if (part.status !== "failed") return afterReply(chat, next);
  const refusal = { reason: ENDINGS[part.ending!], facts };
  return go(
    chat,
    next,
    { kind: "failed", fault: { kind: "refused", refusal } },
    [],
  );
}

// A part that ended with `text`: one that wrote nothing failed.
function ended(
  base: Omit<ReplyEntry, "status" | "text" | "ending">,
  text: string,
  ending: Ending | null,
): ReplyEntry {
  if (text === "")
    return { ...base, status: "failed", text, ending: ending ?? "empty" };
  return {
    ...base,
    status: ending === null ? "complete" : "stopped",
    text,
    ending,
  };
}

// What a reply to continue leaves in the log when it isn't continued: its
// part ended with `ending`, then the passes made for it.
function uncontinued(log: Log, cut: Cut, ending: Ending): Log {
  return [
    ...log,
    ...(cut.part ? [{ ...cut.part, status: "stopped" as const, ending }] : []),
    ...cut.passes,
  ];
}

// Compacts the chat to continue its last reply: the part `cut.part`, or
// the last part in the log. `command` is true for a continue asked by hand,
// which is refused rather than recorded when it can't start.
function beginContinue(chat: Chat, cut: Cut, command: boolean): Outcome {
  const { log } = chat;
  const view = [...log, ...(cut.part ? [cut.part] : []), ...cut.passes];
  const plan = compactionPlan(view, chat.model, { kind: "continue" });
  if (command && plan === null) return refuse(chat, NO_ROOM);
  if (command && plan?.blocked) return refuse(chat, plan.blocked.reason);
  if (plan === null) {
    const ended = uncontinued(log, cut, "no-room");
    return go(chat, ended, settledPhase(ended), []);
  }
  if (plan.blocked)
    return go(
      chat,
      uncontinued(log, cut, "no-compaction"),
      blockedBy(plan.blocked),
      [],
    );
  const made = compaction(chat, plan, view.length);
  return go(
    made.chat,
    log,
    { kind: "continuing", compaction: made.compacting, cut },
    [made.effect],
  );
}

function replyCompleted(
  chat: Chat,
  writing: Writing,
  completion: Completion,
  elapsedMillis: number,
): Outcome {
  const { maxTokens } = writing;
  const spent =
    writing.spent +
    Math.min(completion.usage.completionTokens ?? maxTokens, maxTokens);
  const base = {
    kind: "reply" as const,
    providerMessage: null,
    model: completion.model,
    usage: completion.usage,
    maxTokens,
    compaction: writing.compaction,
    postedAt: chat.now,
    elapsedMillis,
  };
  const { text } = completion;
  const log = chat.log;
  // What a part that wrote nothing ended on.
  const facts = {
    stopped: completion.stopped ?? "no",
    characters: text.length,
    completionTokens: completion.usage.completionTokens ?? "unreported",
    maxTokens,
    bound: writing.bound,
    model: completion.model,
  };
  if (completion.stopped === null)
    return endReply(chat, log, ended(base, text, null), facts);
  if (completion.stopped === "timeout")
    return endReply(chat, log, ended(base, text, "timeout"), facts);
  if (writing.bound !== "cut")
    return endReply(
      chat,
      log,
      ended(base, text, writing.bound === "reply" ? "reply-limit" : "length"),
      facts,
    );
  if (writing.continuations === MAX_CONTINUATIONS)
    return endReply(chat, log, ended(base, text, "cut-off"), facts);
  // Cut at the cut line: the unfinished last block is dropped, and the
  // continuation writes it.
  const prefix = replyParts(log)
    .map((index) => (log[index] as ReplyEntry).text)
    .join("");
  const joined = prefix + text;
  const kept = joined.slice(prefix.length, cleanBreak(joined, prefix.length));
  if (kept === "") return endReply(chat, log, ended(base, "", "length"), facts);
  return beginContinue(
    chat,
    {
      part: { ...base, status: "cut", text: kept, ending: null },
      passes: [],
      spent,
      continuations: writing.continuations + 1,
    },
    false,
  );
}

// Why a summary can't be used, with what it was written as, or null.
function summaryRefusal(completion: Completion, plan: Plan): Refusal | null {
  const reason =
    completion.stopped === "length"
      ? "The summary reached its length limit."
      : completion.stopped === "timeout"
        ? "The summary timed out."
        : completion.text.trim() === ""
          ? "The model wrote an empty summary."
          : null;
  if (reason === null) return null;
  return {
    reason,
    facts: {
      stopped: completion.stopped ?? "no",
      characters: completion.text.length,
      summaryTokens: completion.usage.completionTokens ?? "unreported",
      maxTokens: plan.maxTokens,
      model: completion.model,
    },
  };
}

type CompactionPhase = Extract<
  Phase,
  { kind: "compacting" | "continuing" | "making-room" }
>;
type MakingRoom = Extract<Phase, { kind: "making-room" }>;

// The log a message making room is planned on: what it goes after, then
// the passes made for it.
const roomView = (chat: Chat, phase: MakingRoom): Log => [
  ...chat.log.slice(0, phase.base),
  ...phase.passes,
];

// A compaction that failed. A new message is not sent, but given back, and
// the passes made for it are kept; a retried one keeps its place, its
// failed reply replaced by this failure, or, when it had a reply, the log as
// it was. A reply cut at the cut line ends where it was cut.
function compactionFailed(
  chat: Chat,
  phase: CompactionPhase,
  fault: Fault,
  blocked: Refusal | null,
): Outcome {
  const failure: Phase = { kind: "compaction-failed", fault, blocked };
  if (phase.kind === "making-room") {
    if (!phase.retry)
      return go(chat, [...chat.log, ...phase.passes], failure, [
        { kind: "return", message: phase.message },
      ]);
    if (settledPhase(chat.log).kind !== "failed")
      return go(chat, chat.log, failure, []);
    return go(
      chat,
      [
        ...roomView(chat, phase),
        phase.message,
        failedPart(chat, null, "", "not-compacted", null),
      ],
      { kind: "failed", fault },
      [],
    );
  }
  if (phase.kind === "continuing")
    return go(
      chat,
      uncontinued(chat.log, phase.cut, "no-compaction"),
      failure,
      [],
    );
  return go(chat, chat.log, failure, []);
}

// Sends a message once there is room for it, compacting again until there
// is. A final pass planned for the message (`own`) leaves room for any
// message within its share, so one that doesn't fails rather than
// compacting again; one the message waited for was planned without it.
function makeRoom(chat: Chat, phase: MakingRoom, own: boolean): Outcome {
  const view = roomView(chat, phase);
  const occasion = {
    kind: "send",
    message: phase.message,
    incoming: phase.incoming,
  } as const;
  if (!compactionDue(view, chat.model, occasion))
    return startReply(chat, [...view, phase.message], 0, 0);
  const plan =
    own && phase.passes.at(-1)?.pass === "final"
      ? null
      : compactionPlan(view, chat.model, occasion);
  if (plan === null)
    return compactionFailed(
      chat,
      phase,
      {
        kind: "refused",
        refusal: roomRefusal(view, chat.model, phase.incoming),
      },
      null,
    );
  if (plan.blocked)
    return compactionFailed(
      chat,
      phase,
      { kind: "refused", refusal: plan.blocked },
      plan.blocked,
    );
  const made = compaction(chat, plan, view.length);
  return go(made.chat, chat.log, { ...phase, compaction: made.compacting }, [
    made.effect,
  ]);
}

function summaryCompleted(
  chat: Chat,
  phase: CompactionPhase,
  completion: Completion,
): Outcome {
  const { plan } = phase.compaction;
  const unusable = summaryRefusal(completion, plan);
  if (unusable)
    return compactionFailed(
      chat,
      phase,
      { kind: "refused", refusal: unusable },
      null,
    );
  const entry: CompactionEntry = {
    kind: "compaction",
    summary: {
      text: completion.text.trim(),
      tokens: completion.usage.completionTokens ?? plan.maxTokens,
      model: completion.model,
    },
    kept: plan.kept,
    pass: plan.pass,
    instruction: plan.instruction,
  };
  if (phase.kind === "making-room")
    return makeRoom(
      chat,
      { ...phase, passes: [...phase.passes, entry], adopted: false },
      !phase.adopted,
    );
  if (phase.kind === "continuing") {
    const { cut } = phase;
    const passes = [...cut.passes, entry];
    if (plan.pass === "partial")
      return beginContinue(chat, { ...cut, passes }, false);
    return startReply(
      chat,
      [...chat.log, ...(cut.part ? [cut.part] : []), ...passes],
      cut.spent,
      cut.continuations,
    );
  }
  // A compaction runs its passes to the final one.
  const log = [...chat.log, entry];
  if (plan.pass === "final") return go(chat, log, settledPhase(log), []);
  const next = compactionPlan(log, chat.model, { kind: "asked" });
  if (next === null) return go(chat, log, settledPhase(log), []);
  if (next.blocked) return go(chat, log, blockedBy(next.blocked), []);
  const made = compaction(chat, next, log.length);
  return go(made.chat, log, { ...phase, compaction: made.compacting }, [
    made.effect,
  ]);
}

// Stops the request `id`: dropped when it waits for a write, else aborted.
function cancel(chat: Chat, id: number): { chat: Chat; effects: Effect[] } {
  const waiting = chat.saving?.then.some(
    (effect) => effect.kind === "request" && effect.id === id,
  );
  if (waiting && chat.saving)
    return {
      chat: {
        ...chat,
        saving: {
          ...chat.saving,
          then: chat.saving.then.filter(
            (effect) => !(effect.kind === "request" && effect.id === id),
          ),
        },
      },
      effects: [],
    };
  return { chat, effects: [{ kind: "abort", id }] };
}

// Stops what runs. A reply ends with what it wrote; a compaction stops
// without an entry, a new message's passes so far kept and the message
// given back, a retried message's dropped with the log left as it was.
function stop(chat: Chat, elapsedMillis: number | null): Outcome {
  const { phase } = chat;
  if (phase.kind === "writing") {
    const cancelled = cancel(chat, phase.reply.request);
    const { reply } = phase;
    const part = ended(
      {
        kind: "reply",
        providerMessage: null,
        model: null,
        usage: null,
        maxTokens: reply.maxTokens,
        compaction: reply.compaction,
        postedAt: chat.now,
        elapsedMillis,
      },
      reply.text,
      "stopped",
    );
    const outcome = endReply(cancelled.chat, chat.log, part, {
      stoppedBy: "person",
      elapsedMillis: elapsedMillis ?? "unmeasured",
      maxTokens: reply.maxTokens,
    });
    return { ...outcome, effects: [...cancelled.effects, ...outcome.effects] };
  }
  if (
    phase.kind !== "making-room" &&
    phase.kind !== "compacting" &&
    phase.kind !== "continuing"
  )
    return unchanged(chat);
  const cancelled = cancel(chat, phase.compaction.request);
  let log: Log = chat.log;
  const returned: Effect[] = [];
  if (phase.kind === "making-room" && !phase.retry) {
    log = [...chat.log, ...phase.passes];
    returned.push({ kind: "return", message: phase.message });
  }
  if (phase.kind === "continuing")
    log = uncontinued(chat.log, phase.cut, "stopped");
  const outcome = go(cancelled.chat, log, settledPhase(log), returned);
  return { ...outcome, effects: [...cancelled.effects, ...outcome.effects] };
}

// Sends `message` after the log's first `base` entries: checked on the
// request it makes before anything is written, then sent, after a
// compaction when it needs room. A message sent while the chat compacts
// waits for that compaction, then for any more it needs.
function admit(
  chat: Chat,
  base: number,
  message: UserEntry,
  retry: boolean,
): Outcome {
  const facts = chat.model;
  const budget = budgetOf(facts);
  const small = contextRefusal(facts);
  if (small) return refuse(chat, small.reason);
  const incoming = messageEstimate({
    text: message.text,
    photos: message.photos,
    ...(message.audio
      ? {
          audio: {
            encodedLength: message.audio.encodedLength,
            ...(message.audio.durationMillis !== null
              ? { durationMillis: message.audio.durationMillis }
              : {}),
          },
        }
      : {}),
  });
  if (incoming > budget.message)
    return refuse(chat, message.audio ? RECORDING_TOO_LONG : MESSAGE_TOO_LONG);
  const log = chat.log.slice(0, base);
  const issue = replyMediaRefusal([...log, message], facts);
  if (issue) return refuse(chat, issue.reason);
  if (chat.phase.kind === "compacting")
    return go(
      chat,
      chat.log,
      {
        kind: "making-room",
        message,
        base,
        passes: [],
        retry,
        incoming,
        adopted: true,
        compaction: chat.phase.compaction,
      },
      [],
    );
  const occasion = { kind: "send", message, incoming } as const;
  if (!compactionDue(log, facts, occasion)) {
    const prepared = prepareReply([...log, message], facts, 0);
    if ("issue" in prepared) return refuse(chat, prepared.issue.reason);
    return startReply(chat, [...log, message], 0, 0);
  }
  const plan = compactionPlan(log, facts, occasion);
  if (plan === null) return refuse(chat, NO_ROOM);
  if (plan.blocked) return refuse(chat, plan.blocked.reason);
  const made = compaction(chat, plan, base);
  return go(
    made.chat,
    chat.log,
    {
      kind: "making-room",
      message,
      base,
      passes: [],
      retry,
      incoming,
      adopted: false,
      compaction: made.compacting,
    },
    [made.effect],
  );
}

// The log's last reply asked again: a failed continuation from the
// compaction that cut it, else the whole reply from its message. Each
// starts a fresh allowance, as a continue asked by hand does.
function retry(chat: Chat): Outcome {
  const { log } = chat;
  const last = log.at(-1);
  const previous = log.at(-2);
  const continuation =
    last?.kind === "compaction" && last.instruction !== null
      ? log
      : last?.kind === "reply" &&
          last.status === "failed" &&
          previous?.kind === "compaction" &&
          previous.instruction !== null
        ? log.slice(0, -1)
        : null;
  if (continuation) {
    const prepared = prepareReply(continuation, chat.model, 0);
    if ("issue" in prepared) return refuse(chat, prepared.issue.reason);
    return startReply(chat, continuation, 0, 0);
  }
  const user = log.findLastIndex((entry) => entry.kind === "user");
  return admit(chat, user, log[user] as UserEntry, true);
}

// The compaction the chat would make if asked now.
const askedPlan = (log: Log, facts: ModelFacts) =>
  compactionPlan(log, facts, { kind: "reply" }) ??
  compactionPlan(log, facts, { kind: "asked" });

function compact(chat: Chat): Outcome {
  const plan = askedPlan(chat.log, chat.model);
  if (chat.phase.kind === "compaction-failed") {
    if (plan === null) return go(chat, chat.log, settledPhase(chat.log), []);
    if (plan.blocked)
      return unchanged({
        ...chat,
        phase: { ...chat.phase, blocked: plan.blocked },
      });
  } else {
    if (plan === null) return refuse(chat, NOTHING_TO_COMPACT);
    if (plan.blocked) return refuse(chat, plan.blocked.reason);
  }
  const made = compaction(chat, plan, chat.log.length);
  return go(
    made.chat,
    chat.log,
    { kind: "compacting", why: "asked", compaction: made.compacting },
    [made.effect],
  );
}

// The chat with `model`: a failed compaction's block is read again for it.
function withModel(chat: Chat, model: ModelFacts): Outcome {
  const next = { ...chat, model };
  if (chat.phase.kind !== "compaction-failed") return unchanged(next);
  const blocked = askedPlan(chat.log, model)?.blocked ?? null;
  return unchanged({ ...next, phase: { ...chat.phase, blocked } });
}

function command(chat: Chat, event: Command): Outcome {
  const refused = refusal(chat, event.kind);
  if (refused) return refuse(chat, refused);
  switch (event.kind) {
    case "send": {
      const text = event.text.trim();
      if (!text && event.photos.length === 0)
        return refuse(chat, EMPTY_MESSAGE);
      return admit(
        chat,
        chat.log.length,
        {
          kind: "user",
          text,
          audio: null,
          photos: event.photos,
          postedAt: chat.now,
        },
        false,
      );
    }
    case "send-recording":
      return admit(
        chat,
        chat.log.length,
        {
          kind: "user",
          text: "",
          audio: event.audio,
          photos: [],
          postedAt: chat.now,
        },
        false,
      );
    case "retry":
      return retry(chat);
    case "continue":
      return beginContinue(
        chat,
        { part: null, passes: [], spent: 0, continuations: 0 },
        true,
      );
    case "compact":
      return compact(chat);
    case "change-model":
      return withModel(chat, event.model);
    case "stop":
      return stop(chat, event.elapsedMillis);
    // The failed exchange is dropped, its message given back.
    case "discard": {
      const user = chat.log.findLastIndex((entry) => entry.kind === "user");
      const log = chat.log.slice(0, user);
      return go(chat, log, settledPhase(log), [
        { kind: "return", message: chat.log[user] as UserEntry },
      ]);
    }
    case "save-again": {
      const phase = chat.phase as Extract<Phase, { kind: "unsaved" }>;
      const write = writeOf(chat.store, chat.log, shared(chat.store, chat.log));
      return {
        chat: {
          ...chat,
          phase: phase.resume,
          saving: { write, then: phase.then },
        },
        effects: [write],
        refused: null,
      };
    }
  }
}

// While unsaved, the phase it interrupted still takes its requests'
// results; what they would write or send waits for the save.
function whileUnsaved(
  chat: Chat,
  phase: Extract<Phase, { kind: "unsaved" }>,
  event: Result,
): Outcome {
  const held: WriteEffect = { kind: "write", keep: 0, entries: [], sent: null };
  const inner = stepAt(
    { ...chat, phase: phase.resume, saving: { write: held, then: phase.then } },
    event,
  );
  return unchanged({
    ...inner.chat,
    saving: null,
    phase: {
      ...phase,
      resume: inner.chat.phase,
      then: inner.chat.saving!.then.filter((effect) => effect.kind !== "write"),
    },
  });
}

const compactingFor = (
  phase: Phase,
  request: number,
): phase is CompactionPhase =>
  (phase.kind === "compacting" ||
    phase.kind === "continuing" ||
    phase.kind === "making-room") &&
  phase.compaction.request === request;

export function step(chat: Chat, event: Event, now: number): Outcome {
  const outcome = stepAt({ ...chat, now }, event);
  // A refused command leaves the chat as it was.
  return outcome.refused === null ? outcome : { ...outcome, chat };
}

function stepAt(chat: Chat, event: Event): Outcome {
  const { phase } = chat;
  if (
    phase.kind === "unsaved" &&
    event.kind !== "saved" &&
    event.kind !== "save-failed" &&
    (event.kind === "chunk" ||
      event.kind === "completed" ||
      event.kind === "request-failed" ||
      event.kind === "capabilities")
  )
    return whileUnsaved(chat, phase, event);
  switch (event.kind) {
    case "chunk":
      if (phase.kind !== "writing" || phase.reply.request !== event.request)
        return unchanged(chat);
      return unchanged({
        ...chat,
        phase: { ...phase, reply: { ...phase.reply, text: event.text } },
      });
    case "completed":
      if (phase.kind === "writing" && phase.reply.request === event.request)
        return replyCompleted(
          chat,
          phase.reply,
          event.completion,
          event.elapsedMillis,
        );
      if (compactingFor(phase, event.request))
        return summaryCompleted(chat, phase, event.completion);
      return unchanged(chat);
    case "request-failed":
      if (phase.kind === "writing" && phase.reply.request === event.request)
        return go(
          chat,
          [
            ...chat.log,
            failedPart(
              chat,
              event.elapsedMillis,
              phase.reply.text,
              event.providerError ? "provider-error" : "request-failed",
              event.providerError?.message ?? null,
            ),
          ],
          {
            kind: "failed",
            fault: { kind: "thrown", reason: event.error, cause: event.cause },
          },
          [],
        );
      if (compactingFor(phase, event.request))
        return compactionFailed(
          chat,
          phase,
          { kind: "thrown", reason: event.error, cause: event.cause },
          null,
        );
      return unchanged(chat);
    case "saved": {
      if (chat.saving === null) return unchanged(chat);
      const { write, then } = chat.saving;
      return release(
        {
          ...chat,
          store: [...chat.store.slice(0, write.keep), ...write.entries],
          saving: null,
        },
        then,
      );
    }
    case "save-failed": {
      if (chat.saving === null) return unchanged(chat);
      return unchanged({
        ...chat,
        saving: null,
        phase: {
          kind: "unsaved",
          cause: event.cause,
          resume: phase,
          then: chat.saving.then.filter((effect) => effect.kind !== "write"),
        },
      });
    }
    case "capabilities":
      if (event.model.id !== chat.model.id) return unchanged(chat);
      return withModel(chat, event.model);
    default:
      return command(chat, event);
  }
}
