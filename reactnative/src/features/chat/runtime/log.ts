import { endsBlock, tailStart } from "./breaks.ts";
import { requestIssue, type InputIssues } from "./capability.ts";
import {
  chatBudget,
  COMPACT_AT_MEDIA_BYTES,
  compactionInstruction,
  CONTEXT_FLOOR,
  CONTEXT_TOO_SMALL,
  continueInstruction,
  FRAMING_TOKENS,
  messageEstimate,
  NO_ROOM,
  SUMMARY_HEADING,
  SUMMARY_TOO_LARGE,
  textTokens,
  type Budget,
} from "./compaction.ts";
import { MAX_REPLY_TOKENS } from "../../../providers/openrouter/metadata.ts";
import type { Usage } from "../../../providers/openrouter/transport.ts";

// A request carries at most this much media, the newest.
export const MEDIA_BUDGET_BYTES = 12 * 1024 * 1024;
// What an older photo or recording past the budget is replaced by, in the
// text of its message.
export const PHOTO_LEFT_OUT = "[A photo was here. It is no longer included.]";
export const RECORDING_LEFT_OUT =
  "[A voice recording was here. It is no longer included.]";
// The bytes a photo or recording takes, from the length of its base64 text.
export function mediaBytes(media: { encodedLength: number }): number {
  return Math.ceil((media.encodedLength * 3) / 4);
}
// A recording's levels reduced to at most the bars a message shows.
export function summarizeLevels(levels: number[]): number[] {
  const count = Math.min(32, levels.length);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * levels.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * levels.length) / count),
    );
    return Math.max(...levels.slice(start, end));
  });
}

// A chat is an append-only log of entries. A request is read from it: the
// last compaction entry as it says it was given, then every entry after it.

// Media is held by reference: its bytes stay where they are saved, and the
// runtime reads them into a request as it sends it.
export type AudioRef = {
  key: string;
  format: string;
  encodedLength: number;
  durationMillis: number | null;
  // The recording's loudness, reduced to the bars a message shows; null
  // when none was measured.
  levels: number[] | null;
};
export type PhotoRef = {
  key: string;
  width: number;
  height: number;
  encodedLength: number;
};
export type UserEntry = {
  kind: "user";
  text: string;
  audio: AudioRef | null;
  photos: PhotoRef[];
  // When it was sent, in epoch milliseconds; null on messages saved before
  // times were kept.
  postedAt: number | null;
};
// How a reply part ended short of complete, as a code: the screen words it
// where it is shown, so no sentence of ours is saved. A stopped part was
// stopped by the person (`stopped`); reached the model's own output limit
// (`length`), the reply's whole limit (`MAX_REPLY_TOKENS`, `reply-limit`)
// or the continuation limit (`MAX_CONTINUATIONS`, `cut-off`); timed out;
// or its continuation's compaction failed (`no-compaction`) or had no room
// (`no-room`). A failed part ended in one of those having written nothing,
// wrote nothing (`empty`), or was never answered: the model's context is too
// small (`too-small`), it can't take the conversation's media
// (`unsupported-input`), there was no room for the reply (`no-room`), the
// compaction its retried message needed failed (`not-compacted`), its
// request failed (`request-failed`) or the provider answered with an error
// (`provider-error`), or the app closed before it finished (`closed`).
export type Ending =
  | "stopped"
  | "length"
  | "reply-limit"
  | "cut-off"
  | "timeout"
  | "empty"
  | "no-compaction"
  | "no-room"
  | "too-small"
  | "unsupported-input"
  | "not-compacted"
  | "request-failed"
  | "provider-error"
  | "closed";
// One request's part of a reply. A reply is its parts after its message:
// each part but the last is `cut` at the cut line and followed by the
// compaction entry its continuation was asked from. `compaction` is the
// index of the compaction entry its request began with; `model` and `usage`
// are what the completion reported, null when none came.
export type ReplyEntry = {
  kind: "reply";
  status: "complete" | "cut" | "stopped" | "failed";
  text: string;
  // Null exactly when the part is complete or cut.
  ending: Ending | null;
  // The provider's own words on what went wrong, as it sent them, on a part
  // that ended `provider-error`; null on every other, and when it sent none.
  providerMessage: string | null;
  model: string | null;
  usage: Usage | null;
  // The most its request was allowed to write; null on replies saved before
  // it was kept.
  maxTokens: number | null;
  compaction: number | null;
  // When it ended, and how long its request took, in milliseconds; null
  // when unknown.
  postedAt: number | null;
  elapsedMillis: number | null;
};
// Characters `from`..`to` of entry `entry`'s text; a user entry's range is
// always all of it, with its media.
export type Range = { entry: number; from: number; to: number };
export type Summary = { text: string; tokens: number; model: string };
// A compaction: the summary, what is given word for word after it (each
// item one message, made of ranges of earlier entries) and the instruction
// to continue a reply it cut, as they were sent. A `final` pass's summary
// covers everything before it; a `partial` one's covers all but what it
// keeps, which the next pass summarises.
export type CompactionEntry = {
  kind: "compaction";
  summary: Summary;
  kept: Range[][];
  pass: "final" | "partial";
  instruction: string | null;
};
export type Entry = UserEntry | ReplyEntry | CompactionEntry;
export type Log = readonly Entry[];

// A request message as the provider takes it, its media by reference.
export type RequestMessage = {
  role: "system" | "user" | "assistant";
  text: string;
  audio?: AudioRef;
  photos?: PhotoRef[];
};

// What the chat's model is, as far as requests are concerned.
// `answering` is the model an alias points at now: a reported count is
// trusted only when that model wrote it.
export type ModelFacts = {
  id: string;
  answering: string;
  contextLength: number | null;
  maxOutput: number;
  issues: InputIssues;
};

// Why a log isn't one this code works with, or null. Logs are checked where
// they enter (loading, migration); nothing repairs them.
export function logIssue(log: Log): string | null {
  for (let index = 0; index < log.length; index++) {
    const entry = log[index];
    const next = log[index + 1];
    if (entry.kind === "user") {
      if (!entry.text && !entry.audio && entry.photos.length === 0)
        return `Entry ${index} says nothing.`;
      // A message may go unanswered only where a failed reply to it was
      // dropped before this format (see the v16 migration).
      if (next?.kind === "compaction") return `Entry ${index} isn't answered.`;
      continue;
    }
    if (entry.kind === "reply") {
      if (entry.status === "failed" && next !== undefined)
        return `Entry ${index} failed but isn't last.`;
      if (entry.status !== "failed" && entry.text === "")
        return `Entry ${index} is an empty reply.`;
      if (
        (entry.ending === null) !==
        (entry.status === "complete" || entry.status === "cut")
      )
        return `Entry ${index} has an ending that doesn't match its status.`;
      if (entry.ending === "provider-error" && entry.status !== "failed")
        return `Entry ${index} has a provider's error but didn't fail.`;
      if (entry.providerMessage !== null && entry.ending !== "provider-error")
        return `Entry ${index} has a provider message without its error.`;
      // A cut part is followed by the passes its continuation was asked
      // from, the last one final with the instruction.
      const passes = log.slice(index + 1);
      const end = passes.findIndex(
        (e) => e.kind !== "compaction" || e.pass === "final",
      );
      const continued = passes[end] as Entry | undefined;
      if (
        entry.status === "cut" &&
        (continued?.kind !== "compaction" || continued.instruction === null)
      )
        return `Entry ${index} is cut but not continued.`;
      if (next?.kind === "reply")
        return `Entry ${index} is followed by a reply.`;
      // A reply answers its message, or continues after the compaction that
      // cut its earlier part.
      const answered = log
        .slice(0, index)
        .findLast((e) => e.kind !== "compaction");
      const previous = log[index - 1] as Entry | undefined;
      if (
        answered?.kind !== "user" &&
        !(previous?.kind === "compaction" && previous.instruction !== null)
      )
        return `Entry ${index} answers nothing.`;
      continue;
    }
    for (const group of entry.kept) {
      if (group.length === 0) return `Entry ${index} keeps an empty message.`;
      for (const range of group) {
        const kept = log[range.entry] as Entry | undefined;
        if (
          range.entry >= index ||
          kept === undefined ||
          kept.kind === "compaction"
        )
          return `Entry ${index} keeps what isn't before it.`;
        const whole = range.from === 0 && range.to === kept.text.length;
        if (
          kept.kind === "user"
            ? !whole || group.length > 1
            : range.from < 0 ||
              range.from >= range.to ||
              range.to > kept.text.length
        )
          return `Entry ${index} keeps a range that isn't there.`;
      }
    }
    if (entry.instruction !== null) {
      if (entry.pass !== "final") return `Entry ${index} continues partially.`;
      const before = log
        .slice(0, index)
        .findLast((e) => e.kind !== "compaction");
      if (before?.kind !== "reply" || before.status === "failed")
        return `Entry ${index} continues no reply.`;
      if (next !== undefined && next.kind !== "reply")
        return `Entry ${index} isn't followed by its continuation.`;
    }
  }
  // A log may end with a message or a continuation's compaction that has no
  // reply yet: one is being written, or the app closed while it was.
  return null;
}

// Where a request's message comes from.
type Source =
  | { kind: "summary"; summary: Summary }
  | { kind: "instruction" }
  | { kind: "kept"; ranges: Range[] }
  | { kind: "entry"; index: number };
type Item = {
  source: Source;
  // Whether the summary in the request already covers it.
  summarised: boolean;
  message: RequestMessage;
};

function lastCompaction(log: Log): number | null {
  const index = log.findLastIndex((entry) => entry.kind === "compaction");
  return index === -1 ? null : index;
}

function userMessage(entry: UserEntry): RequestMessage {
  return {
    role: "user",
    text: entry.text,
    ...(entry.audio ? { audio: entry.audio } : {}),
    ...(entry.photos.length ? { photos: entry.photos } : {}),
  };
}

function keptMessage(log: Log, ranges: Range[]): RequestMessage {
  const first = log[ranges[0].entry];
  if (first.kind === "user") return userMessage(first);
  return {
    role: "assistant",
    text: ranges
      .map((range) => {
        const entry = log[range.entry] as ReplyEntry;
        return entry.text.slice(range.from, range.to);
      })
      .join(""),
  };
}

function entryMessage(entry: UserEntry | ReplyEntry): RequestMessage {
  return entry.kind === "user"
    ? userMessage(entry)
    : { role: "assistant", text: entry.text };
}

// The request's items in order, before the media budget.
function layout(log: Log): { at: number | null; items: Item[] } {
  const at = lastCompaction(log);
  const items: Item[] = [];
  if (at !== null) {
    const entry = log[at] as CompactionEntry;
    items.push({
      source: { kind: "summary", summary: entry.summary },
      summarised: true,
      message: {
        role: "system",
        text: `${SUMMARY_HEADING}${entry.summary.text}`,
      },
    });
    for (const ranges of entry.kept)
      items.push({
        source: { kind: "kept", ranges },
        summarised: entry.pass === "final",
        message: keptMessage(log, ranges),
      });
    if (entry.instruction !== null)
      items.push({
        source: { kind: "instruction" },
        summarised: true,
        message: { role: "user", text: entry.instruction },
      });
  }
  for (let index = (at ?? -1) + 1; index < log.length; index++) {
    const entry = log[index];
    if (entry.kind === "compaction") continue;
    items.push({
      source: { kind: "entry", index },
      summarised: false,
      message: entryMessage(entry),
    });
  }
  return { at, items };
}

// The messages as a request carries them: the newest media within the
// budget, and every older photo or recording replaced by a placeholder after
// its message's text.
function withinMediaBudget(messages: RequestMessage[]): RequestMessage[] {
  let remaining = MEDIA_BUDGET_BYTES;
  const fits = (media: { encodedLength: number }) => {
    const bytes = mediaBytes(media);
    if (bytes > remaining) remaining = -1;
    else remaining -= bytes;
    return remaining >= 0;
  };
  const carried: RequestMessage[] = [];
  for (const message of [...messages].reverse()) {
    const left: string[] = [];
    const audio = message.audio !== undefined && fits(message.audio);
    if (message.audio && !audio) left.push(RECORDING_LEFT_OUT);
    const photos: PhotoRef[] = [];
    for (const photo of [...(message.photos ?? [])].reverse())
      if (fits(photo)) photos.unshift(photo);
      else left.push(PHOTO_LEFT_OUT);
    if (left.length === 0) {
      carried.unshift(message);
      continue;
    }
    const shown: RequestMessage = {
      role: message.role,
      text: [message.text, left.join("\n")].filter(Boolean).join("\n\n"),
    };
    if (audio) shown.audio = message.audio;
    if (photos.length) shown.photos = photos;
    carried.unshift(shown);
  }
  return carried;
}

// The request a reply in this chat is sent now.
export function replyRequest(log: Log): RequestMessage[] {
  return withinMediaBudget(layout(log).items.map((item) => item.message));
}

const sum = (values: number[]) => values.reduce((all, value) => all + value, 0);

function estimate(message: RequestMessage): number {
  return messageEstimate({
    text: message.text,
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
    ...(message.photos ? { photos: message.photos } : {}),
  });
}

// The request with each message's tokens in a request to `answering`. A
// reported count is trusted only for an entry after the compaction its
// request began with, written by the same model; never above the estimate.
type Sized = {
  at: number | null;
  items: Item[];
  messages: RequestMessage[];
  sizes: number[];
};
function sized(log: Log, answering: string): Sized {
  const { at, items } = layout(log);
  const messages = withinMediaBudget(items.map((item) => item.message));
  const sizes = items.map((item, index) => {
    const message = messages[index];
    const { source } = item;
    if (source.kind === "summary")
      return (
        FRAMING_TOKENS +
        textTokens(SUMMARY_HEADING) +
        (source.summary.model === answering
          ? source.summary.tokens
          : textTokens(source.summary.text))
      );
    if (source.kind === "instruction")
      return FRAMING_TOKENS + textTokens(message.text);
    const guess = estimate(message);
    if (source.kind === "kept") return guess;
    const entry = log[source.index];
    if (
      entry.kind !== "reply" ||
      entry.model !== answering ||
      entry.compaction !== at
    )
      return guess;
    const written =
      entry.usage?.completionTokens ??
      (entry.maxTokens === null
        ? textTokens(entry.text)
        : Math.min(textTokens(entry.text), entry.maxTokens));
    return Math.min(guess, FRAMING_TOKENS + written);
  });
  return { at, items, messages, sizes };
}

// The tokens of the request a reply is sent now, its own framing included:
// the sum of its messages, or, when less, what the latest reply after the
// same compaction by the same model reported its request held, its own text
// and what follows it. A message before that reply may since have lost
// media to the budget, which a newer message's took: its placeholder text
// wasn't in the request reported, and may hold more than the media did (a
// tiny photo, a short recording), so each such message's text is counted
// again in full, as nothing of what was reported is known to be it.
function measure(
  { at, items, messages, sizes }: Sized,
  log: Log,
  answering: string,
) {
  const estimated = FRAMING_TOKENS + sum(sizes);
  const latest = items.findLastIndex(({ source }) => {
    if (source.kind !== "entry") return false;
    const entry = log[source.index];
    return (
      entry.kind === "reply" &&
      entry.usage?.promptTokens != null &&
      entry.usage.completionTokens != null &&
      entry.compaction === at &&
      entry.model === answering
    );
  });
  if (latest === -1) return estimated;
  const source = items[latest].source as { kind: "entry"; index: number };
  const reply = log[source.index] as ReplyEntry;
  const usage = reply.usage!;
  const reported = withinMediaBudget(
    items.slice(0, latest).map((item) => item.message),
  );
  const placeholders = sum(
    reported.map((sent, index) =>
      sent.text === messages[index].text ? 0 : textTokens(messages[index].text),
    ),
  );
  const measured =
    usage.promptTokens! +
    (reply.status === "failed" ? 0 : usage.completionTokens!) +
    placeholders +
    FRAMING_TOKENS +
    sum(sizes.slice(latest + 1));
  return Math.min(estimated, measured);
}

export function requestSize(log: Log, facts: ModelFacts): number {
  return measure(sized(log, facts.answering), log, facts.answering);
}

export function budgetOf(facts: ModelFacts): Budget {
  return chatBudget(facts.contextLength);
}

// Why something can't be sent, with the facts that was decided from: plain
// strings and numbers, kept as they were wherever the refusal goes, so the
// screen can show what it was decided from.
export type Refusal = {
  reason: string;
  facts: Readonly<Record<string, string | number>>;
};

// Why a chat with this model can't hold a conversation, or null.
export function contextRefusal(facts: ModelFacts): Refusal | null {
  const { limit } = budgetOf(facts);
  return limit < CONTEXT_FLOOR
    ? {
        reason: CONTEXT_TOO_SMALL,
        facts: { limit, floor: CONTEXT_FLOOR, model: facts.id },
      }
    : null;
}

// Why the log has no room for a message of `incoming` tokens and its reply.
export function roomRefusal(
  log: Log,
  facts: ModelFacts,
  incoming: number,
): Refusal {
  const budget = budgetOf(facts);
  return {
    reason: NO_ROOM,
    facts: {
      requestTokens: requestSize(log, facts),
      incoming,
      cut: budget.cut,
      replyRoom: budget.room,
      limit: budget.limit,
      model: facts.id,
    },
  };
}

// The entry a request's item comes from: a summary or an instruction comes
// from the compaction the request begins with.
function entryOf(at: number | null, { source }: Item): number {
  if (source.kind === "entry") return source.index;
  if (source.kind === "kept") return source.ranges[0].entry;
  return at!;
}

// Why the model can't take what `request`, whose messages start with the
// items', carries, and which entry carries it, or null.
function mediaRefusal(
  at: number | null,
  items: Item[],
  request: RequestMessage[],
  facts: ModelFacts,
): Refusal | null {
  const issue = requestIssue(request, facts.issues);
  if (issue === null) return null;
  return {
    reason: issue.reason,
    facts: {
      entry: entryOf(at, items[issue.message]),
      input: issue.input,
      model: facts.id,
    },
  };
}

// Why the model can't take what the log's reply request carries, or null.
export function replyMediaRefusal(log: Log, facts: ModelFacts): Refusal | null {
  const { at, items } = layout(log);
  return mediaRefusal(at, items, replyRequest(log), facts);
}

// Media not yet summarised: what follows the last compaction, and what a
// partial one left.
function unsummarisedMedia(log: Log, items: Item[]): number {
  return sum(
    items.flatMap(({ source, summarised }) =>
      summarised
        ? []
        : source.kind === "entry"
          ? [entryMedia(log[source.index])]
          : source.kind === "kept"
            ? source.ranges.map((range) => entryMedia(log[range.entry]))
            : [],
    ),
  );
}

function entryMedia(entry: Entry): number {
  if (entry.kind !== "user") return 0;
  return (
    (entry.audio ? mediaBytes(entry.audio) : 0) +
    sum(entry.photos.map((photo) => mediaBytes(photo)))
  );
}

// Why a compaction is looked for: a reply finished, `message`, of
// `incoming` tokens, is about to be sent, the user asked for one, or a reply
// is to be continued.
export type Occasion =
  | { kind: "reply" }
  | { kind: "send"; message: UserEntry; incoming: number }
  | { kind: "asked" }
  | { kind: "continue" };

export function compactionDue(
  log: Log,
  facts: ModelFacts,
  occasion: Occasion,
): boolean {
  const budget = budgetOf(facts);
  const view = sized(log, facts.answering);
  const size = measure(view, log, facts.answering);
  if (occasion.kind === "reply")
    return (
      size > budget.compactAt ||
      unsummarisedMedia(log, view.items) > COMPACT_AT_MEDIA_BYTES
    );
  // The request the message makes, as its reply is checked: its media may
  // take the budget from earlier messages', which then count as text.
  if (occasion.kind === "send")
    return (
      requestSize([...log, occasion.message], facts) > budget.cut - budget.room
    );
  return true;
}

// One compaction pass: its request, the entry it makes but for its summary,
// and why it can't be sent (`blocked`), or null.
export type Plan = {
  messages: RequestMessage[];
  maxTokens: number;
  pass: "final" | "partial";
  kept: Range[][];
  instruction: string | null;
  blocked: Refusal | null;
};

function itemRanges(log: Log, item: Item): Range[] {
  if (item.source.kind === "kept") return item.source.ranges;
  if (item.source.kind !== "entry") return [];
  const index = item.source.index;
  return [{ entry: index, from: 0, to: (log[index] as UserEntry).text.length }];
}

// Ranges of the reply's parts from character `start` of the parts joined.
function partRanges(log: Log, parts: number[], start: number): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  for (const index of parts) {
    const text = (log[index] as ReplyEntry).text;
    const from = Math.max(start - offset, 0);
    if (from < text.length)
      ranges.push({ entry: index, from, to: text.length });
    offset += text.length;
  }
  return ranges;
}

// The parts of the log's last reply.
export function replyParts(log: Log): number[] {
  const user = log.findLastIndex((entry) => entry.kind === "user");
  const parts: number[] = [];
  for (let index = user + 1; index < log.length; index++)
    if (log[index].kind === "reply") parts.push(index);
  return parts;
}

// The compaction due for the log on `occasion`, or null when none is or
// there is nothing to compact. Its request is the reply request's messages
// through those it covers, then the instruction: all of them when that fits
// the limit with the summary's output, else the oldest that do, and the
// next pass takes the rest. A final pass also keeps the latest exchange word
// for word when it is wholly after the last compaction, its media is under
// the media trigger, and it fits beside a summary within the target (and,
// before a send, with the new message within the reply room). A pass that
// continues a reply keeps the exchange whole or else the reply's end within
// the tail share, and the instruction to continue it.
export function compactionPlan(
  log: Log,
  facts: ModelFacts,
  occasion: Occasion,
): Plan | null {
  if (!compactionDue(log, facts, occasion)) return null;
  const budget = budgetOf(facts);
  const view = sized(log, facts.answering);
  const { items, messages, sizes } = view;
  const open = items.findIndex((item) => !item.summarised);
  const start = open === -1 ? items.length : open;
  const unsummarised = items.length - start;
  const earlier = view.at !== null;
  // A reply is continued from a summary of its own even when nothing is
  // left to summarise: the instruction comes with one.
  if (unsummarised === 0 && items.length <= 1 && occasion.kind !== "continue")
    return null;
  const instructionTokens =
    FRAMING_TOKENS +
    textTokens(compactionInstruction(budget.summaryOutput, earlier));
  const through = (count: number) =>
    FRAMING_TOKENS + instructionTokens + sum(sizes.slice(0, start + count));
  const room = budget.limit - budget.summaryOutput;
  let count = unsummarised;
  let requestTokens = Math.min(
    through(count),
    measure(view, log, facts.answering) + instructionTokens,
  );
  if (requestTokens > room && unsummarised > 0) {
    count = 1;
    while (count < unsummarised && through(count + 1) <= room) count++;
    requestTokens = through(count);
  }
  const final = count === unsummarised;
  const maxTokens = Math.min(
    budget.summaryOutput,
    budget.limit - requestTokens,
  );
  const request = [
    ...messages.slice(0, start + count),
    {
      role: "user" as const,
      text: compactionInstruction(maxTokens, earlier),
    },
  ];
  let kept: Range[][] = [];
  let instruction: string | null = null;
  if (!final) {
    kept = items.slice(start + count).map((item) => itemRanges(log, item));
  } else {
    const user = items.findLastIndex(
      ({ source }) =>
        source.kind === "entry" && log[source.index].kind === "user",
    );
    if (user !== -1) {
      const exchange = items.slice(user);
      const within =
        occasion.kind === "send"
          ? Math.min(
              budget.target,
              budget.cut - budget.room - occasion.incoming,
            )
          : budget.target;
      const media = sum(
        exchange.map(({ source }) =>
          source.kind === "entry" ? entryMedia(log[source.index]) : 0,
        ),
      );
      if (
        media <= COMPACT_AT_MEDIA_BYTES &&
        budget.summary + sum(sizes.slice(user)) <= within
      )
        kept = exchange.map((item) => itemRanges(log, item));
    }
    if (occasion.kind === "continue") {
      const parts = replyParts(log);
      const joined = parts
        .map((index) => (log[index] as ReplyEntry).text)
        .join("");
      const whole = kept.length > 0;
      if (!whole) {
        const tail = tailStart(joined, (end) => textTokens(end) <= budget.tail);
        const ranges = partRanges(log, parts, tail);
        kept = ranges.length ? [ranges] : [];
      }
      instruction = continueInstruction({
        shown: whole ? "whole" : "end",
        at: endsBlock(joined) ? "paragraph" : "mid-text",
      });
    }
  }
  return {
    messages: request,
    maxTokens,
    pass: final ? "final" : "partial",
    kept,
    instruction,
    blocked:
      contextRefusal(facts) ??
      (requestTokens > room
        ? tooLarge(view, start + count, requestTokens, room, facts)
        : mediaRefusal(view.at, items, request, facts)),
  };
}

// Why a compaction request of `requestTokens` through the first `count`
// items is over the `room` its summary leaves: its largest item, and the
// entry that comes from.
function tooLarge(
  view: Sized,
  count: number,
  requestTokens: number,
  room: number,
  facts: ModelFacts,
): Refusal {
  const sizes = view.sizes.slice(0, count);
  const largest = sizes.indexOf(Math.max(...sizes));
  return {
    reason: SUMMARY_TOO_LARGE,
    facts: {
      entry: entryOf(view.at, view.items[largest]),
      entryTokens: sizes[largest],
      requestTokens,
      room,
      limit: budgetOf(facts).limit,
      model: facts.id,
    },
  };
}

// What a reply's request may write: the room left under the cut line, the
// model's own limit or what is left of the reply's whole limit, whichever is
// least, and which of them that is.
export type Bound = "cut" | "model" | "reply";
export type Prepared = {
  messages: RequestMessage[];
  maxTokens: number;
  bound: Bound;
  compaction: number | null;
};

// The request a reply's next part is sent, with `spent` tokens written by
// its earlier requests, or why it can't be sent.
export function prepareReply(
  log: Log,
  facts: ModelFacts,
  spent: number,
): Prepared | { issue: Refusal; ending: Ending } {
  const budget = budgetOf(facts);
  const small = contextRefusal(facts);
  if (small) return { issue: small, ending: "too-small" };
  const media = replyMediaRefusal(log, facts);
  if (media) return { issue: media, ending: "unsupported-input" };
  const messages = replyRequest(log);
  const room = budget.cut - requestSize(log, facts);
  if (room < budget.room)
    return { issue: roomRefusal(log, facts, 0), ending: "no-room" };
  const left = MAX_REPLY_TOKENS - spent;
  const bound = Math.min(facts.maxOutput, left);
  return {
    messages,
    maxTokens: Math.min(room, bound),
    bound: room < bound ? "cut" : left < facts.maxOutput ? "reply" : "model",
    compaction: lastCompaction(log),
  };
}
