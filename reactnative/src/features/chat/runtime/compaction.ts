import { tailStart } from "./breaks.ts";

// The budget. A chat's limit is the most tokens one of its requests may
// hold with what it writes: the smaller of this cap and the model's context
// window. Every share below is a percentage of it, and every request is
// sized from above (see the estimates below), so they hold of what is sent.
export const CONTEXT_CAP = 4_000;
// The smallest limit a chat works within: below it, the room above the cut
// line can't hold the compaction instruction beside the summary (checked
// below, where the module loads).
export const CONTEXT_FLOOR = 4_000;
// One message may take half the limit: beside the least a compaction
// leaves (the summary) and the reply room it stays within the cut line.
const MESSAGE_PERCENT = 50;
// A chat past this after a reply is compacted in the background. A send
// fits while the chat with the message stays within the cut line less the
// reply room, so a chat left under this takes a message up to the gap
// between them; a larger one, or one sent near this, waits for a compaction.
const COMPACT_AT_PERCENT = 70;
// No request with what it writes goes past this. The rest of the limit, the
// reserve, holds the compaction instruction and the summary it writes, so a
// compaction of everything sent so far always fits.
const CUT_PERCENT = 85;
// A summary, with its heading and framing, takes at most this.
const SUMMARY_PERCENT = 10;
// A compaction leaves the history at most here: half the compaction
// threshold, so a chat takes as much conversation again before the next.
const TARGET_PERCENT = 35;
// Every reply request may write at least this much.
const REPLY_ROOM_PERCENT = 15;
// The most of a cut reply's end its continuation is shown word for word,
// when the exchange isn't kept whole.
const TAIL_PERCENT = 15;
if (SUMMARY_PERCENT + MESSAGE_PERCENT + REPLY_ROOM_PERCENT > CUT_PERCENT)
  throw new Error(
    "A message at the cap must fit beside a summary and the reply room.",
  );
// A reply cut at the cut line is compacted and continued at most this many
// times; then it ends cut off.
export const MAX_CONTINUATIONS = 3;

// Estimates, each from above. A text's tokens are counted with OpenAI's
// o200k_base vocabulary, plus a margin: other model families tokenize the
// same text differently, often into more tokens, and the estimate must err
// high.
const TOKEN_MARGIN_PERCENT = 20;
// The tokenizer's vocabulary takes megabytes, so it is loaded with a chat's
// resources rather than with the app; sizing text before then is a bug.
// The tokenizer didn't load, which is the app's own code failing to arrive,
// not anything of the user's.
export class TokenizerLoadError extends Error {
  constructor(cause: unknown) {
    super("The tokenizer couldn’t be loaded.", { cause });
    this.name = "TokenizerLoadError";
  }
}
let countTokens: ((text: string) => number) | null = null;
let loading: Promise<void> | null = null;
export function loadTokenizer(): Promise<void> {
  loading ??= import("gpt-tokenizer/encoding/o200k_base").then(
    (tokenizer) => {
      // Text that spells a special token is counted as plain text.
      const plain = { disallowedSpecial: new Set<string>() };
      countTokens = (text) => tokenizer.countTokens(text, plain);
      checkFloor();
    },
    (cause: unknown) => {
      loading = null;
      throw new TokenizerLoadError(cause);
    },
  );
  return loading;
}
export function textTokens(text: string): number {
  if (countTokens === null) throw new Error("The tokenizer isn't loaded.");
  return Math.ceil((countTokens(text) * (100 + TOKEN_MARGIN_PERCENT)) / 100);
}
// Estimate: what a chat template adds around each message or media part
// (role and turn markers, about four tokens in ChatML, Llama 3 and Gemma),
// doubled; also allowed once per request for the reply's opening.
export const FRAMING_TOKENS = 8;
// Estimate: a photo's tokens at Anthropic's documented width × height / 750,
// the densest of the common rates (Qwen 784 px a token; Gemini 258 per
// 768-pixel tile; OpenAI 170 per 512-pixel tile).
const PHOTO_PIXELS_PER_TOKEN = 750;
// Exact for Gemini, which documents 32 tokens per second of audio.
const AUDIO_TOKENS_PER_SECOND = 32;
// Estimate: an attached audio file has no duration, so its duration is
// taken from its size at 16 kbit/s, a low speech bitrate. A file encoded
// below it holds more than this counts.
const ATTACHED_AUDIO_BYTES_PER_SECOND = 2_000;

export type Budget = {
  limit: number;
  message: number;
  compactAt: number;
  cut: number;
  summary: number;
  target: number;
  room: number;
  tail: number;
  // The most tokens a summary's text may take: its share, less its heading,
  // its framing and the request's.
  summaryOutput: number;
};
export function chatBudget(contextLength: number | null): Budget {
  const limit = Math.min(CONTEXT_CAP, contextLength ?? CONTEXT_CAP);
  const share = (percent: number) => Math.floor((limit * percent) / 100);
  const summary = share(SUMMARY_PERCENT);
  return {
    limit,
    message: share(MESSAGE_PERCENT),
    compactAt: share(COMPACT_AT_PERCENT),
    cut: share(CUT_PERCENT),
    summary,
    target: share(TARGET_PERCENT),
    room: share(REPLY_ROOM_PERCENT),
    tail: share(TAIL_PERCENT),
    summaryOutput: summary - textTokens(SUMMARY_HEADING) - 2 * FRAMING_TOKENS,
  };
}

// The summary leads as a system message under this heading, so it reads as
// background the conversation continues from rather than as a turn of it.
export const SUMMARY_HEADING =
  "Record of this conversation so far, written from earlier messages that are no longer included. The most recent messages may follow in full.\n\n";

// What a chat's limit lets it hold. A message is refused before it is
// saved when the chat's limit is below the floor or it is over its share.
export const CONTEXT_TOO_SMALL =
  "This model’s context window is too small for a conversation.";
export const MESSAGE_TOO_LONG = "That message is too long for this model.";
export const RECORDING_TOO_LONG = "That recording is too long for this model.";
export const NO_ROOM =
  "That message doesn’t fit in what’s left of this conversation.";
export const COMPACTION_FAILED =
  "Couldn’t compact this conversation. Retry the compaction to continue.";
export const SUMMARY_TOO_LARGE =
  "One message in this conversation is too large for this model to summarize. A model with a larger context window can continue it.";
export const CUT_OFF = "Cut off at this conversation’s length limit.";
// A reply's own record of a continuation its compaction couldn't make room
// for. The marker under it tells why and retries.
export const COMPACTION_CUT_OFF =
  "Cut off: the conversation couldn’t be compacted.";

// A recording stopped by the budget stops this much short of what fits, so
// a stop that fires late still leaves it within the message's share.
const RECORDING_HEADROOM_SECONDS = 2;
// How long a recording may run, in whole seconds: what a message within the
// budget's share holds (its framing, and its audio's), less the headroom.
export function recordingSeconds(budget: Budget): number {
  return (
    Math.floor(
      (budget.message - 2 * FRAMING_TOKENS) / AUDIO_TOKENS_PER_SECOND,
    ) - RECORDING_HEADROOM_SECONDS
  );
}

// What a message's size is read from: its words, media and, on a reply,
// what the provider reported of it.
type Sized = {
  text: string;
  audio?:
    | { durationMillis?: number; encodedLength: number }
    | { durationMillis?: number; data: string };
  photos?: ({ width: number; height: number } & (
    { encodedLength: number } | { data: string }
  ))[];
};

// Estimate: a message's tokens with `text` as its words.
export function messageEstimate(message: Sized): number {
  let tokens = FRAMING_TOKENS + textTokens(message.text);
  for (const photo of message.photos ?? [])
    tokens +=
      FRAMING_TOKENS +
      Math.ceil((photo.width * photo.height) / PHOTO_PIXELS_PER_TOKEN);
  const audio = message.audio;
  if (audio) {
    const seconds =
      audio.durationMillis !== undefined
        ? audio.durationMillis / 1000
        : Math.ceil(
            (("encodedLength" in audio
              ? audio.encodedLength
              : audio.data.length) *
              3) /
              4,
          ) / ATTACHED_AUDIO_BYTES_PER_SECOND;
    tokens += FRAMING_TOKENS + Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND);
  }
  return tokens;
}

// A chat whose media not yet summarised passes this after a reply is
// compacted too, before requests that carry only the newest media replace
// the older with placeholders.
export const COMPACT_AT_MEDIA_BYTES = 8 * 1024 * 1024;

// What the summariser is told, after the conversation: not to answer it,
// who reads the record, and what the record holds. With an `earlier`
// summary in the request it is also told to carry that over, so a summary
// neither loses detail nor grows on every compaction.
//
// The length a summary is asked to aim for, and the most of `tokens`, its
// hard limit, that it is asked to aim for when that is less. A summary cut
// off at its limit fails the compaction, and a model overshoots what it aims
// for, more so one that counts tokens differently than the limit was sized
// with, so the aim stays well under the limit.
const SUMMARY_TARGET_TOKENS = 2_000;
const SUMMARY_TARGET_PERCENT = 60;
export function compactionInstruction(
  tokens: number,
  earlier: boolean,
): string {
  const target = Math.min(
    SUMMARY_TARGET_TOKENS,
    Math.floor((tokens * SUMMARY_TARGET_PERCENT) / 100),
  );
  return [
    "Stop here and don’t reply to the conversation above. Write a record of it for another model, which will continue the conversation from your record without seeing these messages. Return only the record.",
    [
      "Cover, in this order:",
      "- Goal: what the user is trying to get done, and anything they said about how they want replies.",
      "- Established: facts, decisions and results so far. Keep names, numbers and the user’s own wording exact.",
      "- Open: questions and requests that haven’t been answered yet.",
      "- Latest: what the last reply covered and where it stopped.",
    ].join("\n"),
    ...(earlier
      ? [
          "The conversation starts with an earlier record. Carry over what it holds unless later messages contradict or resolve it, so the new record replaces the old one and doesn’t grow with every round.",
        ]
      : []),
    `Leave out what was resolved and no longer matters. Write in the conversation’s language, in about ${target} tokens.`,
  ].join("\n\n");
}

// A cut reply as its continuation is given it: `shown` whole or only its
// end, and cut `at` the end of a paragraph or in the middle of its text.
export type ContinuedCut = {
  shown: "whole" | "end";
  at: "paragraph" | "mid-text";
};

// What a model is told to continue a reply cut at the cut line, after the
// reply so far when it is shown whole, else after its end. It says whose
// message it is and where the answer goes: a model that takes it for the
// user's answers the user about continuing. And it says how the reply so
// far ends, at the end of a paragraph or inside one, so the model doesn't
// have to work that out: told only to go on from where the text stops, it
// adds words to a sentence that had ended.
export function continueInstruction(cut: ContinuedCut): string {
  return [
    cut.shown === "whole"
      ? "Your reply above was cut off at its length limit."
      : "Your last reply was cut off at its length limit. Above is only its end; the record covers the rest.",
    "This message is from the app, not the user, who won’t see it.",
    cut.at === "paragraph"
      ? "What you write next is added to that reply as its next paragraph, so begin a new paragraph that follows on from the last one."
      : "What you write next is added straight onto the end of that reply, so write only its next words, starting exactly where it stops, mid-sentence if that’s where it is.",
    "Carry on until the reply is complete. Don’t acknowledge this message, don’t repeat or sum up what’s already written, and don’t start over.",
  ].join(" ");
}

// The most of a cut reply's end its continuation is shown word for word.
const CONTINUE_TAIL_TOKENS = 300;
// The end of a cut reply `text` its continuation is shown: within the
// tail's tokens, from a clean break where one is. The summary covers the
// rest.
export function replyTail(text: string): string {
  return text.slice(
    tailStart(text, (tail) => textTokens(tail) <= CONTINUE_TAIL_TOKENS),
  );
}

// The limit below which the instruction doesn't fit the reserve: a history
// at the cut line, its framing, the instruction and the summary it writes.
// Checked once the tokenizer loads, which fails the chat's resources.
function checkFloor() {
  const floor = chatBudget(CONTEXT_FLOOR);
  const instruction =
    FRAMING_TOKENS +
    // The longer of the two: the one for a chat that has a summary.
    textTokens(compactionInstruction(floor.summaryOutput, true));
  if (
    floor.summaryOutput <= 0 ||
    floor.cut + 2 * FRAMING_TOKENS + instruction + floor.summaryOutput >
      floor.limit
  )
    throw new Error("The compaction instruction doesn't fit at the floor.");
  // A continuation shown only the reply's end is given the summary, that end
  // and the longest instruction to continue, within the target.
  const continued = Math.max(
    ...(["whole", "end"] as const).flatMap((shown) =>
      (["paragraph", "mid-text"] as const).map((at) =>
        textTokens(continueInstruction({ shown, at })),
      ),
    ),
  );
  if (
    floor.summary + floor.tail + 2 * FRAMING_TOKENS + continued >
    floor.target
  )
    throw new Error("A continuation's end doesn't fit at the floor.");
}
