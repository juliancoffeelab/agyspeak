import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import * as compactionModule from "../src/features/chat/runtime/compaction.ts";
import * as logModule from "../src/features/chat/runtime/log.ts";
import * as machineModule from "../src/features/chat/runtime/machine.ts";
import { entry as savedEntry } from "../src/migrations/history/v16.ts";
import {
  chatBudget,
  COMPACT_AT_MEDIA_BYTES,
  compactionInstruction,
  CONTEXT_FLOOR,
  continueInstruction,
  FRAMING_TOKENS,
  loadTokenizer,
  CONTEXT_TOO_SMALL,
  messageEstimate,
  NO_ROOM,
  SUMMARY_HEADING,
  SUMMARY_TOO_LARGE,
  textTokens,
} from "../src/features/chat/runtime/compaction.ts";
import { requestIssue } from "../src/features/chat/runtime/capability.ts";
import { endsBlock, tailStart } from "../src/features/chat/runtime/breaks.ts";
import {
  compactionPlan,
  logIssue,
  MEDIA_BUDGET_BYTES,
  PHOTO_LEFT_OUT,
  RECORDING_LEFT_OUT,
} from "../src/features/chat/runtime/log.ts";
import {
  ALL_SAVED,
  COMMANDS,
  COMPACTING,
  ENDINGS,
  CONTINUING,
  LAST_FAILED,
  MAKING_ROOM,
  MODEL_IN_USE,
  NOT_COMPACTED,
  NOTHING_RUNNING,
  ONLY_FAILED,
  openChat,
  refusal,
  step,
  UNSAVED,
  WRITING,
} from "../src/features/chat/runtime/machine.ts";

await loadTokenizer();

// A continuation's end and its instruction fit beside a summary within the
// target at the smallest window a chat works in.
test("a continuation's end fits beside a summary at the floor", () => {
  const budget = chatBudget(CONTEXT_FLOOR);
  for (const shown of ["whole", "end"])
    for (const at of ["paragraph", "mid-text"])
      assert.ok(
        budget.summary +
          budget.tail +
          2 * FRAMING_TOKENS +
          textTokens(continueInstruction({ shown, at })) <=
          budget.target,
      );
});

const MOCK_MEDIA_TAKEN = { audio: null, image: null };
const MOCK_MEDIA_REFUSED = {
  audio: "No audio here.",
  image: "No photos here.",
};
// The chat's models: a large one, the same id after its alias moved, a
// small text-only one with a short output limit, and one below the floor.
const MOCK_MODELS = [
  {
    id: "a",
    answering: "a1",
    contextLength: 128_000,
    maxOutput: 100_000,
    issues: MOCK_MEDIA_TAKEN,
  },
  {
    id: "a",
    answering: "a2",
    contextLength: 128_000,
    maxOutput: 100_000,
    issues: MOCK_MEDIA_TAKEN,
  },
  {
    id: "b",
    answering: "b",
    contextLength: 4_000,
    maxOutput: 400,
    issues: MOCK_MEDIA_REFUSED,
  },
  {
    id: "b",
    answering: "b",
    contextLength: 4_000,
    maxOutput: 400,
    issues: MOCK_MEDIA_TAKEN,
  },
  {
    id: "c",
    answering: "c",
    contextLength: 3_000,
    maxOutput: 1_000,
    issues: MOCK_MEDIA_TAKEN,
  },
];

const WORDS = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
// Text of at most `tokens` tokens, in paragraphs.
function text(tokens, seed) {
  if (tokens <= 0) return "";
  const words = [];
  for (let index = 0; index < tokens; index++) {
    words.push(WORDS[(seed + index * 7) % WORDS.length]);
    if (index % 23 === 22) words.push(".\n\n");
  }
  let shown = words.join(" ");
  while (shown && textTokens(shown) > tokens)
    shown = shown.slice(0, Math.floor(shown.length * 0.8)).trimEnd();
  return shown;
}

// A message's true tokens, when the provider counts `scale` of what the
// estimate does for text: what a request must fit within. Every count the
// provider reports is the true one, so the chat's sizes are never below it.
function size(message, scale) {
  const words = (shown) => Math.floor(scale * textTokens(shown));
  if (message.role === "system")
    return (
      FRAMING_TOKENS +
      words(SUMMARY_HEADING) +
      words(message.text.slice(SUMMARY_HEADING.length))
    );
  return (
    messageEstimate({
      text: "",
      ...(message.photos ? { photos: message.photos } : {}),
      ...(message.audio
        ? {
            audio: {
              encodedLength: message.audio.encodedLength,
              durationMillis: message.audio.durationMillis,
            },
          }
        : {}),
    }) + words(message.text)
  );
}
const requestTokens = (messages, scale) =>
  FRAMING_TOKENS +
  messages.reduce((all, message) => all + size(message, scale), 0);

// What the test reads the log as, written out here rather than taken from
// the code that builds requests and compactions.
const sum = (values) => values.reduce((all, value) => all + value, 0);
const bytes = (media) => Math.ceil((media.encodedLength * 3) / 4);
const said = (entry) => ({
  role: "user",
  text: entry.text,
  ...(entry.audio ? { audio: entry.audio } : {}),
  ...(entry.photos.length ? { photos: entry.photos } : {}),
});
const estimateOf = (message) =>
  messageEstimate({
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
    ...(message.photos?.length ? { photos: message.photos } : {}),
  });
// The newest media within the budget; once one doesn't fit, it and all
// older are left out, each named after its message's text.
function carried(messages) {
  let remaining = MEDIA_BUDGET_BYTES;
  const fits = (media) => {
    remaining = bytes(media) > remaining ? -1 : remaining - bytes(media);
    return remaining >= 0;
  };
  return messages
    .toReversed()
    .map((message) => {
      const audio = message.audio !== undefined && fits(message.audio);
      const photos = (message.photos ?? []).toReversed().filter(fits);
      const left = [
        ...(message.audio && !audio ? [RECORDING_LEFT_OUT] : []),
        ...Array((message.photos?.length ?? 0) - photos.length).fill(
          PHOTO_LEFT_OUT,
        ),
      ];
      if (left.length === 0) return message;
      return {
        role: message.role,
        text: [message.text, left.join("\n")].filter(Boolean).join("\n\n"),
        ...(audio ? { audio: message.audio } : {}),
        ...(photos.length ? { photos: photos.toReversed() } : {}),
      };
    })
    .toReversed();
}
// What a request begins with: the last compaction's summary, what it keeps
// (each its ranges' text, a message's media with it) and its instruction,
// then the entries after it; each with where it came from.
function expand(log) {
  const found = log.findLastIndex((entry) => entry.kind === "compaction");
  const at = found === -1 ? null : found;
  const items = [];
  if (at !== null) {
    const { summary, kept, instruction } = log[at];
    items.push({
      source: { kind: "summary", summary },
      message: { role: "system", text: `${SUMMARY_HEADING}${summary.text}` },
    });
    for (const ranges of kept) {
      const first = log[ranges[0].entry];
      const text = ranges
        .map(({ entry, from, to }) => log[entry].text.slice(from, to))
        .join("");
      items.push({
        source: { kind: "kept", ranges },
        message:
          first.kind === "user"
            ? { ...said(first), text }
            : { role: "assistant", text },
      });
    }
    if (instruction !== null)
      items.push({
        source: { kind: "instruction" },
        message: { role: "user", text: instruction },
      });
  }
  log.forEach((entry, index) => {
    if (index > (at ?? -1) && entry.kind !== "compaction")
      items.push({
        source: { kind: "entry", index },
        message:
          entry.kind === "user"
            ? said(entry)
            : { role: "assistant", text: entry.text },
      });
  });
  return { at, items, messages: carried(items.map((item) => item.message)) };
}
// An item's tokens to `answering`: a summary's as its model reported, a
// reply's own by what it wrote when written by it after the same
// compaction, else as estimated; never above the estimate.
function itemTokens(log, at, item, shown, answering) {
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
    return FRAMING_TOKENS + textTokens(shown.text);
  const guess = estimateOf(shown);
  const entry = source.kind === "entry" ? log[source.index] : null;
  if (
    entry?.kind !== "reply" ||
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
}
// The ranges an item is kept as: an entry's whole text.
const rangesOf = (log, { source }) =>
  source.kind === "kept"
    ? source.ranges
    : source.kind === "entry"
      ? [{ entry: source.index, from: 0, to: log[source.index].text.length }]
      : [];

// The compaction entry a summary request answered by `completion` makes,
// by the rules spelled out. `occasion` is what it was planned for: making
// room for a message of `incoming` tokens, continuing a reply, or the
// target after a reply or when asked.
function expectedEntry({ effect, model, log, occasion }, completion) {
  const budget = chatBudget(model.contextLength);
  const { at, items, messages } = expand(log);
  const covered = effect.messages.length - 1;
  const summary = {
    text: completion.text.trim(),
    tokens: completion.usage.completionTokens ?? effect.maxTokens,
    model: completion.model,
  };
  // A partial pass keeps what the next pass still has to summarise.
  if (covered < items.length)
    return {
      kind: "compaction",
      summary,
      kept: items.slice(covered).map((item) => rangesOf(log, item)),
      pass: "partial",
      instruction: null,
    };
  // A final one keeps the latest exchange wholly after the last compaction
  // when its media is under the trigger and it fits beside the summary
  // within the target, and before a send leaves the message its room.
  let kept = [];
  const user = items.findLastIndex(
    ({ source }) =>
      source.kind === "entry" && log[source.index].kind === "user",
  );
  if (user !== -1) {
    const exchange = items.slice(user);
    const within =
      occasion.kind === "send"
        ? Math.min(budget.target, budget.cut - budget.room - occasion.incoming)
        : budget.target;
    const media = sum(
      exchange.map(({ source }) => {
        const entry = log[source.index];
        return entry.kind === "user"
          ? sum([entry.audio, ...entry.photos].filter(Boolean).map(bytes))
          : 0;
      }),
    );
    const tokens = sum(
      exchange.map((item, index) =>
        itemTokens(log, at, item, messages[user + index], model.answering),
      ),
    );
    const fits = (bound) =>
      media <= COMPACT_AT_MEDIA_BYTES && budget.summary + tokens <= bound;
    if (fits(within)) kept = exchange.map((item) => rangesOf(log, item));
    else if (fits(budget.target)) keptButForTheSend++;
  }
  let instruction = null;
  // At a cut: the exchange kept, or else the reply's end within the tail
  // share from a clean break, and how to continue it.
  if (occasion.kind === "continue") {
    const asked = log.findLastIndex((entry) => entry.kind === "user");
    const parts = log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => index > asked && entry.kind === "reply");
    const joined = parts.map(({ entry }) => entry.text).join("");
    const whole = kept.length > 0;
    if (!whole) {
      const tail = tailStart(joined, (end) => textTokens(end) <= budget.tail);
      const ranges = [];
      let offset = 0;
      for (const { entry, index } of parts) {
        const from = Math.max(tail - offset, 0);
        if (from < entry.text.length)
          ranges.push({ entry: index, from, to: entry.text.length });
        offset += entry.text.length;
      }
      kept = ranges.length ? [ranges] : [];
    }
    instruction = continueInstruction({
      shown: whole ? "whole" : "end",
      at: endsBlock(joined) ? "paragraph" : "mid-text",
    });
  }
  return { kind: "compaction", summary, kept, pass: "final", instruction };
}

let keys = 0;
const photo = fc.record({
  width: fc.integer({ min: 200, max: 1200 }),
  height: fc.integer({ min: 150, max: 1200 }),
  encodedLength: fc.integer({ min: 100_000, max: 7_000_000 }),
});
// Photos of few tokens and many bytes: a newer message's leave an older's
// out, its placeholder longer than it was.
const tiny = fc.record({
  width: fc.integer({ min: 1, max: 20 }),
  height: fc.integer({ min: 1, max: 20 }),
  encodedLength: fc.integer({ min: 5_000_000, max: 7_000_000 }),
});
const action = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("send"),
      tokens: fc.oneof(
        fc.integer({ min: 0, max: 900 }),
        fc.integer({ min: 900, max: 2_300 }),
      ),
      seed: fc.nat(),
      photos: fc.array(photo, { maxLength: 2 }),
    }),
  },
  // A message with such a photo answered, then one whose photos leave it
  // out.
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("pictures"),
      seed: fc.nat(),
      older: tiny,
      newer: fc.array(tiny, { minLength: 2, maxLength: 2 }),
    }),
  },
  // A photo answered on the small model, then a long exchange after it on
  // that model once it stops taking photos, or on one below the floor.
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("shrink"),
      to: fc.constantFrom("capabilities", "model"),
      seed: fc.nat(),
      photo,
      tokens: fc.integer({ min: 600, max: 1_500 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("record"),
      seconds: fc.integer({ min: 1, max: 80 }),
      encodedLength: fc.integer({ min: 10_000, max: 6_000_000 }),
    }),
  },
  {
    weight: 10,
    arbitrary: fc.record({
      t: fc.constant("answer"),
      fill: fc.double({ min: 0, max: 1, noNaN: true }),
      stopped: fc.constantFrom(null, null, null, "length", "length", "timeout"),
      reported: fc.boolean(),
      other: fc.boolean(),
      seed: fc.nat(),
    }),
  },
  // A run of replies cut at the cut line, to reach the continuation limit.
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("answer"),
      fill: fc.constant(1),
      stopped: fc.constant("length"),
      reported: fc.boolean(),
      other: fc.constant(false),
      seed: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("fail"),
      how: fc.integer({ min: 0, max: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("chunk"),
      fill: fc.double({ min: 0, max: 1, noNaN: true }),
      seed: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("stale"),
      fill: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant("save"),
      ok: fc.constantFrom(true, true, true, true, true, false),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ t: fc.constant("allowed"), pick: fc.nat() }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constantFrom(
        "retry",
        "continue",
        "compact",
        "discard",
        "save-again",
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("stop") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("model"),
      index: fc.integer({ min: 0, max: MOCK_MODELS.length - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("capabilities"),
      index: fc.integer({ min: 0, max: MOCK_MODELS.length - 1 }),
    }),
  },
);

const PHASE_REASONS = new Set([
  ALL_SAVED,
  COMPACTING,
  CONTINUING,
  LAST_FAILED,
  MAKING_ROOM,
  MODEL_IN_USE,
  NOT_COMPACTED,
  NOTHING_RUNNING,
  ONLY_FAILED,
  UNSAVED,
  WRITING,
]);
const SETTLED = new Set(["ready", "failed", "compaction-failed", "unsaved"]);

// The log a compaction in `phase` was planned on.
function planned(chat) {
  const { phase } = chat;
  if (phase.kind === "making-room")
    return [...chat.log.slice(0, phase.base), ...phase.passes];
  if (phase.kind === "continuing")
    return [
      ...chat.log,
      ...(phase.cut.part ? [phase.cut.part] : []),
      ...phase.cut.passes,
    ];
  return chat.log;
}
// The compactions made and not yet written.
function passes(phase) {
  if (phase.kind === "unsaved") return passes(phase.resume);
  if (phase.kind === "making-room") return phase.passes;
  if (phase.kind === "continuing") return phase.cut.passes;
  return [];
}
const running = (phase) =>
  phase.kind === "unsaved" ? running(phase.resume) : phase;
const compacts = (phase) =>
  phase.kind === "compacting" ||
  phase.kind === "continuing" ||
  phase.kind === "making-room";
// What a compaction in `phase` is planned for.
const occasionOf = (phase) =>
  phase.kind === "making-room"
    ? { kind: "send", incoming: estimateOf(phase.message) }
    : phase.kind === "continuing"
      ? { kind: "continue" }
      : { kind: "target" };
// The effects carried out now or after the write under way.
const coming = (chat, effects) => [
  ...effects,
  ...(chat.saving?.then ?? []),
  ...(chat.phase.kind === "unsaved" ? chat.phase.then : []),
];
// Whether what the screen shows as a failure has its details: a thrown
// error, or the facts a refusal was decided from.
const thrown = (cause) => cause instanceof Error;
const explained = (refusal) =>
  refusal !== null && Object.keys(refusal.facts).length > 0;
// Every sentence of the app's own: what the chat modules export and the
// screen says for each ending, and what this test's failed requests throw.
const SENTENCES = [
  ...[compactionModule, logModule, machineModule].flatMap((module) =>
    Object.values(module).filter(
      (value) => typeof value === "string" && / .*\.$/.test(value.trim()),
    ),
  ),
  ...Object.values(ENDINGS),
  "Provider down.",
];
// A reply entry's saved strings, but for what the model wrote and is.
const savedWords = (entry) =>
  Object.entries(entry)
    .filter(
      ([field, value]) =>
        typeof value === "string" && field !== "text" && field !== "model",
    )
    .map(([, value]) => value);
// What a compaction is blocked by, as `reached` counts it.
const blockedPath = (refusal) =>
  refusal.reason === CONTEXT_TOO_SMALL
    ? "too small"
    : refusal.reason === SUMMARY_TOO_LARGE
      ? "too large"
      : refusal.reason === MOCK_MEDIA_REFUSED.audio ||
          refusal.reason === MOCK_MEDIA_REFUSED.image
        ? "media"
        : null;
// A chat saved with a message larger than a compaction request, as a log
// edited by hand or undone from a compacted one can be at the cap.
const MOCK_OVERSIZED = [
  {
    kind: "user",
    text: text(3_800, 0),
    audio: null,
    photos: [],
    postedAt: 0,
  },
  {
    kind: "reply",
    status: "complete",
    text: text(40, 1),
    ending: null,
    providerMessage: null,
    model: null,
    usage: null,
    maxTokens: null,
    compaction: null,
    postedAt: 0,
    elapsedMillis: null,
  },
];

// Passes that would have kept the exchange but for a send's room.
let keptButForTheSend = 0;
// How often the rarer paths were taken, across runs.
let reached = {
  partial: 0,
  kept: 0,
  end: 0,
  adopted: 0,
  "left out": 0,
  returned: 0,
  "too small": 0,
  "too large": 0,
  media: 0,
  "failed reply": 0,
  "provider message": 0,
};

// Runs effects and answers them, checking the machine after every step.
class World {
  constructor(model, scale, log) {
    this.scale = scale;
    this.chat = openChat(log, model, 0);
    this.clock = 0;
    this.stored = log;
    this.pending = new Map();
    this.aborted = [];
    this.write = null;
    this.facts = new Map();
    this.at = new Map();
    this.made = new Map();
    // The summary requests answered, with what they were answered with.
    this.answered = new Map();
  }

  apply(event) {
    const before = this.chat;
    const known = new Set([...before.log, ...passes(before.phase)]);
    const outcome = step(before, event, (this.clock += 1000));
    const { chat, effects, refused } = outcome;
    this.chat = chat;
    // c. A refusal changes nothing; an allowed command is never refused
    // for the phase.
    if (refused !== null) {
      assert.equal(chat, before);
      assert.deepEqual(effects, []);
    }
    if (event.kind in COMMANDS_BY_KIND) {
      const reason = refusal(before, event.kind);
      if (reason !== null) assert.equal(refused, reason);
      else if (refused !== null)
        assert.ok(!PHASE_REASONS.has(refused), refused);
      if (!COMMANDS[before.phase.kind].includes(event.kind))
        assert.notEqual(reason, null);
    }
    // A message is refused for the room only when compacting can't make it.
    if (refused === NO_ROOM && event.kind.startsWith("send"))
      assert.equal(
        compactionPlan(before.log, before.model, { kind: "asked" }),
        null,
      );
    // a. The log is well formed and only grows, but for a retry, a
    // retried message sent after making room for it, or a discard.
    assert.equal(logIssue(chat.log), null, logIssue(chat.log));
    const resent = (phase) => phase.kind === "making-room" && phase.retry;
    if (
      event.kind !== "retry" &&
      event.kind !== "discard" &&
      !resent(running(before.phase))
    )
      before.log.forEach((entry, index) =>
        assert.equal(chat.log[index], entry, `entry ${index} changed`),
      );
    // d. A compaction lands where its request said, and is what its rules
    // make of the log it was planned on.
    for (const entry of [...chat.log, ...passes(chat.phase)])
      if (entry.kind === "compaction" && !known.has(entry)) {
        assert.equal(event.kind, "completed");
        assert.ok(!this.made.has(entry));
        this.made.set(entry, this.at.get(event.request));
        const { request, completion } = this.answered.get(event.request);
        assert.deepEqual(entry, expectedEntry(request, completion));
        if (entry.pass === "partial") reached.partial++;
        else if (
          ["paragraph", "mid-text"].some(
            (at) =>
              entry.instruction === continueInstruction({ shown: "end", at }),
          )
        )
          reached.end++;
        else if (entry.kept.length) reached.kept++;
      }
    // f. A message sent while the chat compacts waits for that compaction.
    const was = running(before.phase);
    const now = running(chat.phase);
    if (refused === null && event.kind.startsWith("send"))
      if (was.kind === "compacting") {
        reached.adopted++;
        assert.equal(now.kind, "making-room");
        assert.equal(now.adopted, true);
        assert.equal(now.compaction, was.compaction);
        assert.equal(chat.log, before.log);
      }
    // g. A message that waited for room and wasn't sent is given back, the
    // passes made for it kept; a retried one's are dropped.
    const waiting = new Set(coming(before, []));
    const returned = coming(chat, effects).filter(
      (effect) => effect.kind === "return" && !waiting.has(effect),
    );
    if (
      was.kind === "making-room" &&
      now.kind !== "making-room" &&
      !chat.log.includes(was.message)
    ) {
      if (was.retry) assert.deepEqual(returned, []);
      else {
        reached.returned++;
        assert.deepEqual(returned, [{ kind: "return", message: was.message }]);
      }
      if (event.kind === "stop")
        assert.deepEqual(
          chat.log,
          was.retry ? before.log : [...before.log, ...was.passes],
        );
    }
    // A discarded exchange's message is given back.
    if (event.kind === "discard" && refused === null)
      assert.deepEqual(returned, [
        {
          kind: "return",
          message: before.log.findLast((entry) => entry.kind === "user"),
        },
      ]);
    chat.log.forEach((entry, index) => {
      if (entry.kind === "compaction")
        assert.equal(index, this.made.get(entry));
    });
    // h. What the screen shows as a failure has its details: a failed
    // compaction's fault and block, and a failed save's cause.
    const shown = running(chat.phase);
    if (shown.kind === "compaction-failed") {
      const { fault, blocked } = shown;
      assert.ok(
        fault.kind === "thrown"
          ? thrown(fault.cause)
          : explained(fault.refusal),
        JSON.stringify(fault),
      );
      assert.ok(
        blocked === null || explained(blocked),
        JSON.stringify(blocked),
      );
      const path = blocked && blockedPath(blocked);
      if (path) reached[path]++;
    }
    if (chat.phase.kind === "unsaved") assert.ok(thrown(chat.phase.cause));
    // i. A failed reply written now has its fault in the phase, with its
    // details; no reply saves a sentence of the app's, only its ending's
    // code and the provider's own words.
    const last = chat.log.at(-1);
    if (
      last?.kind === "reply" &&
      last.status === "failed" &&
      !before.log.includes(last)
    ) {
      assert.equal(shown.kind, "failed");
      assert.notEqual(shown.fault, null);
    }
    if (shown.kind === "failed" && shown.fault !== null) {
      reached["failed reply"]++;
      assert.ok(
        shown.fault.kind === "thrown"
          ? thrown(shown.fault.cause)
          : explained(shown.fault.refusal),
        JSON.stringify(shown.fault),
      );
    }
    for (const entry of chat.log)
      if (entry.kind === "reply" && !before.log.includes(entry)) {
        if (entry.providerMessage !== null) reached["provider message"]++;
        for (const value of savedWords(entry))
          assert.ok(
            !SENTENCES.some((sentence) => value.includes(sentence)),
            `saved: ${value}`,
          );
      }
    for (const effect of effects) this.run(effect);
    const phase = running(chat.phase);
    if (compacts(phase))
      if (!this.at.has(phase.compaction.request))
        this.at.set(phase.compaction.request, phase.compaction.at);
    for (const effect of [
      ...(chat.saving?.then ?? []),
      ...(chat.phase.kind === "unsaved" ? chat.phase.then : []),
    ])
      if (effect.kind === "request" && !this.facts.has(effect.id))
        this.facts.set(effect.id, {
          model: chat.model,
          log: planned({ ...chat, phase }),
          occasion: occasionOf(phase),
        });
    // e. Whatever runs has a request in flight or waiting for a write.
    if (phase.kind === "writing" || compacts(phase)) {
      const id =
        phase.kind === "writing"
          ? phase.reply.request
          : phase.compaction.request;
      const queued = [
        ...(chat.saving?.then ?? []),
        ...(chat.phase.kind === "unsaved" ? chat.phase.then : []),
      ].some((effect) => effect.kind === "request" && effect.id === id);
      assert.ok(this.pending.has(id) || queued, `request ${id} is lost`);
    }
    if (chat.saving !== null) assert.ok(this.write !== null);
    assert.equal(chat.store.length, this.stored.length);
    chat.store.forEach((entry, index) =>
      assert.equal(entry, this.stored[index]),
    );
    return outcome;
  }

  run(effect) {
    if (effect.kind === "return") return;
    if (effect.kind === "abort") {
      assert.ok(this.pending.has(effect.id));
      this.pending.delete(effect.id);
      this.aborted.push(effect.id);
      return;
    }
    if (effect.kind === "write") {
      assert.equal(this.write, null, "two writes at once");
      // Every entry written is one a read takes back.
      for (const entry of effect.entries) {
        const read = savedEntry.safeParse(JSON.parse(JSON.stringify(entry)));
        assert.ok(read.success, read.error?.message);
      }
      assert.ok(effect.sent === null || effect.entries.includes(effect.sent));
      this.write = effect;
      return;
    }
    const phase = running(this.chat.phase);
    const known = this.facts.get(effect.id) ?? {
      model: this.chat.model,
      log: planned({ ...this.chat, phase }),
      occasion: occasionOf(phase),
    };
    const { model, log, occasion } = known;
    const budget = chatBudget(model.contextLength);
    const { messages, maxTokens } = effect;
    assert.equal(effect.model, model.id);
    // b. A request is read from the log, fits, and carries only what the
    // model takes.
    assert.equal(requestIssue(messages, model.issues), null);
    assert.ok(maxTokens > 0);
    messages.forEach((message, index) => {
      assert.ok(message.role !== "system" || index === 0);
      assert.ok(message.text || message.audio || message.photos?.length);
      if (index > 0 && message.role === "assistant")
        assert.notEqual(messages[index - 1].role, "assistant");
    });
    assert.equal(messages.at(-1).role, "user");
    const tokens = requestTokens(messages, this.scale);
    const expanded = expand(log);
    if (effect.purpose === "reply") {
      assert.deepEqual(messages, expanded.messages);
      if (messages.some((message) => message.text.includes(PHOTO_LEFT_OUT)))
        reached["left out"]++;
      const last = log.at(-1);
      assert.ok(
        last.kind === "user" ||
          (last.kind === "compaction" && last.instruction !== null),
      );
      assert.ok(budget.cut - tokens >= budget.room, "no room left");
      assert.ok(tokens + maxTokens <= budget.cut);
    } else {
      assert.deepEqual(
        messages.slice(0, -1),
        expanded.messages.slice(0, messages.length - 1),
      );
      assert.deepEqual(messages.at(-1), {
        role: "user",
        text: compactionInstruction(maxTokens, expanded.at !== null),
      });
      assert.ok(tokens + maxTokens <= budget.limit, "summary doesn't fit");
    }
    this.pending.set(effect.id, { effect, tokens, model, log, occasion });
  }

  latest() {
    const ids = [...this.pending.keys()];
    return ids.length ? Math.max(...ids) : null;
  }

  completion(request, { fill, stopped, reported, other, seed }) {
    const { effect, tokens, model } = request;
    // A summary mostly arrives whole; a reply ends any way.
    const summary = effect.purpose === "summary";
    const ending = summary
      ? stopped === "timeout" && fill < 0.3
        ? stopped
        : null
      : stopped;
    const written = Math.max(
      ending === "length"
        ? effect.maxTokens
        : Math.floor((summary ? 0.2 + fill * 0.8 : fill) * effect.maxTokens),
      0,
    );
    const shown = text(Math.floor(written / this.scale), seed);
    return {
      text: shown,
      model: other ? "z" : model.answering,
      stopped: ending,
      usage: {
        costUSD: null,
        promptTokens: reported ? tokens : null,
        completionTokens: reported
          ? Math.floor(this.scale * textTokens(shown))
          : null,
        cachedPromptTokens: null,
        cacheWritePromptTokens: null,
      },
    };
  }

  act(action) {
    const id = this.latest();
    switch (action.t) {
      case "send":
        return this.apply({
          kind: "send",
          text: text(action.tokens, action.seed),
          photos: action.photos.map((p) => ({ key: `p${keys++}`, ...p })),
        });
      case "record":
        return this.apply({
          kind: "send-recording",
          audio: {
            key: `r${keys++}`,
            format: "m4a",
            encodedLength: action.encodedLength,
            durationMillis: action.seconds * 1000,
            levels: null,
          },
        });
      case "answer": {
        if (id === null) return;
        const request = this.pending.get(id);
        this.pending.delete(id);
        const completion = this.completion(request, action);
        this.answered.set(id, { request, completion });
        return this.apply({
          kind: "completed",
          request: id,
          completion,
          elapsedMillis: 700,
        });
      }
      case "fail":
        if (id === null) return;
        this.pending.delete(id);
        // A provider's error, with or without its own words, or the
        // request failing without one.
        return this.apply({
          kind: "request-failed",
          request: id,
          error: "Provider down.",
          providerError: [
            null,
            { message: null },
            { message: "Upstream overloaded" },
          ][action.how],
          cause: new Error("down"),
          elapsedMillis: 300,
        });
      case "chunk":
        if (id === null) return;
        return this.apply({
          kind: "chunk",
          request: id,
          text: text(Math.floor(action.fill * 50), action.seed),
        });
      case "stale": {
        const stale = this.aborted.at(-1);
        if (stale === undefined) return;
        return this.apply({
          kind: "completed",
          request: stale,
          completion: {
            text: "late",
            model: "a1",
            stopped: null,
            usage: {
              costUSD: null,
              promptTokens: null,
              completionTokens: null,
              cachedPromptTokens: null,
              cacheWritePromptTokens: null,
            },
          },
          elapsedMillis: 900,
        });
      }
      case "save": {
        if (this.write === null) return;
        const write = this.write;
        this.write = null;
        if (action.ok)
          this.stored = [...this.stored.slice(0, write.keep), ...write.entries];
        return this.apply(
          action.ok
            ? { kind: "saved" }
            : { kind: "save-failed", cause: new Error("disk") },
        );
      }
      case "model":
        return this.apply({
          kind: "change-model",
          model: MOCK_MODELS[action.index],
        });
      case "capabilities":
        return this.apply({
          kind: "capabilities",
          model: MOCK_MODELS[action.index],
        });
      case "allowed": {
        // One of the commands the phase takes, as a user who reads the
        // screen would choose.
        const kinds = COMMANDS[this.chat.phase.kind].filter((kind) =>
          ["retry", "continue", "compact", "discard", "save-again"].includes(
            kind,
          ),
        );
        if (kinds.length === 0) return;
        return this.apply({ kind: kinds[action.pick % kinds.length] });
      }
      case "pictures": {
        const saveAll = () => {
          while (this.write !== null) this.act({ t: "save", ok: true });
        };
        const send = (photos) =>
          this.act({ t: "send", tokens: 5, seed: action.seed, photos });
        if (this.chat.phase.kind !== "ready") return;
        if (send([action.older]).refused !== null) return;
        saveAll();
        if (this.latest() === null) return;
        this.act({
          t: "answer",
          fill: 0.05,
          stopped: null,
          reported: true,
          other: false,
          seed: action.seed,
        });
        saveAll();
        if (this.chat.phase.kind !== "ready") return;
        const outcome = send(action.newer);
        saveAll();
        return outcome;
      }
      case "shrink": {
        const saveAll = () => {
          while (this.write !== null) this.act({ t: "save", ok: true });
        };
        const exchange = (tokens, photos) => {
          if (this.chat.phase.kind !== "ready") return;
          if (
            this.act({ t: "send", tokens, seed: action.seed, photos })
              .refused !== null
          )
            return;
          saveAll();
          if (this.latest() === null) return;
          this.act({
            t: "answer",
            fill: 0.2,
            stopped: null,
            reported: true,
            other: false,
            seed: action.seed,
          });
          saveAll();
        };
        this.act({ t: "model", index: 3 });
        exchange(5, [action.photo]);
        this.act(
          action.to === "model"
            ? { t: "model", index: 4 }
            : { t: "capabilities", index: 2 },
        );
        return exchange(action.tokens, []);
      }
      case "stop":
        return this.apply({
          kind: "stop",
          elapsedMillis:
            running(this.chat.phase).kind === "writing" ? 500 : null,
        });
      default:
        return this.apply({ kind: action.t });
    }
  }

  // e. Answering everything well leaves the chat settled.
  drain() {
    for (let turn = 0; turn < 200; turn++) {
      if (this.write !== null) this.act({ t: "save", ok: true });
      else if (this.chat.phase.kind === "unsaved")
        this.act({ t: "save-again" });
      else if (this.latest() !== null)
        this.act({
          t: "answer",
          fill: 0.3,
          stopped: null,
          reported: true,
          other: false,
          seed: turn,
        });
      else break;
    }
    assert.ok(SETTLED.has(this.chat.phase.kind), this.chat.phase.kind);
    assert.notEqual(this.chat.phase.kind, "unsaved");
    assert.equal(this.write, null);
    assert.equal(this.latest(), null);
    assert.deepEqual(this.stored, this.chat.log);
    assert.equal(logIssue(this.stored), null);
  }
}
const COMMANDS_BY_KIND = Object.fromEntries(
  Object.values(COMMANDS)
    .flat()
    .map((kind) => [kind, true]),
);

test("the chat machine keeps its invariants whatever happens", () => {
  const property = fc.property(
    fc.integer({ min: 0, max: 3 }),
    fc.constantFrom(1, 0.75),
    fc.constantFrom([], [], [], MOCK_OVERSIZED),
    fc.array(action, { minLength: 10, maxLength: 80, size: "max" }),
    (model, scale, log, actions) => {
      const world = new World(MOCK_MODELS[model], scale, log);
      for (const next of actions) world.act(next);
      world.drain();
      // A chat opens again from what was saved.
      openChat(world.stored, world.chat.model, world.clock);
    },
  );
  // The rarer paths are reached by chance: the runs go on, a batch at a
  // time, until each has been.
  for (let batch = 0; batch < 5 && Object.values(reached).includes(0); batch++)
    fc.assert(property, { numRuns: 300 });
  for (const [path, count] of Object.entries(reached))
    assert.ok(count > 0, `never reached: ${path}`);
});

// Every code a reply saves for how it ended is worded on the screen, by a
// sentence of its own.
test("every ending a reply saves has its sentence", () => {
  const codes = savedEntry.options
    .find((option) => option.shape.kind.value === "reply")
    .shape.ending.unwrap().options;
  assert.deepEqual(Object.keys(ENDINGS).sort(), [...codes].sort());
  for (const code of codes) assert.ok(ENDINGS[code].trim(), code);
});

// A reply cut at the cut line goes on until the continuation limit, ends
// cut off, and can be continued by hand from a fresh allowance.
test("a reply cut off at the continuation limit can be continued", () => {
  const world = new World(MOCK_MODELS[0], 1, []);
  world.act({ t: "send", tokens: 50, seed: 1, photos: [] });
  const cut = { fill: 1, stopped: "length", reported: true, other: false };
  const whole = { fill: 0.5, stopped: null, reported: true, other: false };
  const settle = (reply) => {
    for (let turn = 0; turn < 50; turn++) {
      if (world.write !== null) world.act({ t: "save", ok: true });
      else if (world.latest() === null) return;
      else {
        const { purpose } = world.pending.get(world.latest()).effect;
        world.act({
          t: "answer",
          ...(purpose === "reply" ? reply : whole),
          seed: turn,
        });
      }
    }
  };
  settle(cut);
  const parts = world.chat.log.filter((entry) => entry.kind === "reply");
  assert.deepEqual(
    parts.map((part) => part.status),
    ["cut", "cut", "cut", "stopped"],
  );
  assert.equal(parts.at(-1).ending, "cut-off");
  assert.equal(world.chat.phase.kind, "ready");
  assert.equal(refusal(world.chat, "continue"), null);
  world.act({ t: "continue" });
  assert.equal(world.chat.phase.kind, "continuing");
  settle(whole);
  const last = world.chat.log.at(-1);
  assert.equal(last.kind, "reply");
  assert.equal(last.status, "complete");
  world.drain();
});

// A pass that makes room for a message keeps the latest exchange only when
// the message has its room beside it, though the target alone would hold it.
test("a pass before a send keeps the latest exchange only with room for the message", () => {
  const world = new World(MOCK_MODELS[0], 1, []);
  const settle = () => {
    while (world.write !== null) world.act({ t: "save", ok: true });
  };
  const answer = (fill) => {
    settle();
    world.act({
      t: "answer",
      fill,
      stopped: null,
      reported: true,
      other: false,
      seed: 1,
    });
    settle();
  };
  world.act({ t: "send", tokens: 1700, seed: 1, photos: [] });
  answer(0.35);
  world.act({ t: "send", tokens: 500, seed: 2, photos: [] });
  answer(0.1);
  assert.equal(world.chat.phase.kind, "ready");
  const before = keptButForTheSend;
  world.act({ t: "send", tokens: 2400, seed: 3, photos: [] });
  assert.equal(world.chat.phase.kind, "making-room");
  answer(0.5);
  assert.equal(keptButForTheSend, before + 1);
  const pass = world.chat.log.findLast((entry) => entry.kind === "compaction");
  assert.deepEqual(pass.kept, []);
  world.drain();
});

// A message sent while the chat compacts after a reply waits for that
// compaction; stopped once it is made but another is needed, the message
// is given back and the pass made is kept.
test("a message stopped after a pass made room for it is given back, the pass kept", () => {
  const world = new World(MOCK_MODELS[0], 1, []);
  const settle = () => {
    while (world.write !== null) world.act({ t: "save", ok: true });
  };
  const answer = (fill) => {
    settle();
    world.act({
      t: "answer",
      fill,
      stopped: null,
      reported: true,
      other: false,
      seed: 1,
    });
    settle();
  };
  world.act({ t: "send", tokens: 1700, seed: 1, photos: [] });
  answer(0.5);
  world.act({ t: "send", tokens: 200, seed: 2, photos: [] });
  answer(0.6);
  assert.equal(world.chat.phase.kind, "compacting");
  const log = world.chat.log;
  world.act({ t: "send", tokens: 2400, seed: 3, photos: [] });
  const { phase } = world.chat;
  assert.equal(phase.kind, "making-room");
  assert.equal(phase.adopted, true);
  // The compaction it waited for leaves too little room: another is asked.
  answer(1);
  const waiting = world.chat.phase;
  assert.equal(waiting.kind, "making-room");
  assert.equal(waiting.adopted, false);
  assert.equal(waiting.passes.length, 1);
  assert.notEqual(world.latest(), null);
  const { effects } = world.act({ t: "stop" });
  assert.deepEqual(world.chat.log, [...log, ...waiting.passes]);
  assert.deepEqual(coming(world.chat, effects).at(-1), {
    kind: "return",
    message: phase.message,
  });
  world.drain();
  assert.deepEqual(world.stored, [...log, ...waiting.passes]);
});
