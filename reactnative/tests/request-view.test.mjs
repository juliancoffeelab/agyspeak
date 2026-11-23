import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  connect,
  NO_USAGE,
  openChat,
  tick,
  workspace,
} from "./sqlite-helper.mjs";
import { completeReply } from "../src/providers/openrouter/transport.ts";
import {
  requestTranscript,
  shownRequest,
} from "../src/features/chat/runtime/requestView.ts";
import {
  chatBudget,
  CONTEXT_FLOOR,
  SUMMARY_HEADING,
} from "../src/features/chat/runtime/compaction.ts";

// The request view shows what a request sent, bit for bit. Random chats are
// written through the workspace, then the next message is sent through the
// real encoder to a mocked fetch; the view of the log up to that reply must
// equal the body that fetch received. The seed is fixed, so a run is the
// same each time; fast-check prints the seed and path that replay a failure.
// A chat may be compacted before a message is sent, so no message is longer
// than one may be: the generated chats hold whatever the limit is.
const SEED = 0x20261120;
// The chats' model has the smallest window a chat works within (see
// `workspace`), whatever the cap is.
const BUDGET = chatBudget(CONTEXT_FLOOR);
const RUNS = { plain: 34, heavy: 5, compacted: 6 };

const PIECES = [
  "",
  " ",
  "\n",
  "  leading and trailing  \n\n",
  "\t\ttabs\t",
  "\r\nCRLF lines\r\n",
  "emoji 👩‍👩‍👧 🇺🇦 👍🏽",
  "combining e\u0301 a\u0308 n\u0303",
  "RTL שלום עולם مرحبا بالعالم",
  "CJK 漢字 かな カナ 한국어",
  "# Heading\n\n**bold** _it_ `code`\n\n- item\n1. one\n> quote",
  "```js\nconst x = 1;\n```",
  "zero\u200bwidth\u00a0nbsp\ufeffbom",
  "plain words",
];
const piece = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PIECES) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 12 }) },
);
// A long text is a generated chunk repeated to a generated length, up to
// the most one message may take.
const longText = fc
  .tuple(
    piece,
    fc.integer({
      min: Math.floor(BUDGET.message / 4),
      max: Math.floor(BUDGET.message / 2),
    }),
  )
  .map(([chunk, length]) =>
    `Lorem ipsum ünïcødé. ${chunk}`.repeat(length).slice(0, length),
  );
const text = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.array(piece, { maxLength: 3 }).map((parts) => parts.join("")),
  },
  { weight: 1, arbitrary: longText },
);

// Base64 of a generated length: a small chunk repeated, then any tail, so a
// size shrinks by its count alone.
const base64 = (minChunks, maxChunks) =>
  fc
    .tuple(
      fc.constantFrom("AAAA", "/9j/", "QUJD", "UklG"),
      fc.integer({ min: minChunks, max: maxChunks }),
      fc.constantFrom("", "A", "AA", "AAA", "AA==", "AAA="),
    )
    .map(([chunk, count, tail]) => chunk.repeat(count) + tail);
const KB = Math.floor(1024 / 3);
const MB = Math.floor((1024 * 1024) / 3);
// Most chats carry small media; a heavy one carries enough to pass the
// 12 MB budget, so its oldest media messages are left out. A message's
// photos stay within its 8 MB limit.
const SIZES = {
  light: {
    media: 2,
    photo: base64(1, 48 * KB),
    pair: base64(1, 24 * KB),
    audio: base64(1, 48 * KB),
  },
  heavy: {
    media: 9,
    photo: base64(3 * MB, 6 * MB),
    pair: base64(1, 3 * MB),
    audio: base64(4 * MB, 6 * MB),
  },
};

function turn(heavy) {
  const sizes = heavy ? SIZES.heavy : SIZES.light;
  const photo = (data) => ({ data, thumbnail: "/9j/", width: 4, height: 3 });
  return fc.oneof(
    {
      weight: 10 - sizes.media,
      // A message without photos says something, or it isn't sent.
      arbitrary: text.map((words) => ({
        kind: "text",
        text: `u${words}`,
        photos: [],
      })),
    },
    {
      weight: Math.ceil(sizes.media / 3),
      arbitrary: fc.record({
        kind: fc.constant("audio"),
        audio: fc.record({
          data: sizes.audio,
          format: fc.constantFrom("wav", "mp3", "m4a"),
          durationMillis: fc.constant(1000),
        }),
      }),
    },
    {
      weight: sizes.media,
      arbitrary: fc.record({
        kind: fc.constant("text"),
        // Photo-only messages are common.
        text: fc.oneof(fc.constant(""), text),
        photos: fc.oneof(
          sizes.photo.map((data) => [photo(data)]),
          fc.tuple(sizes.pair, sizes.pair).map((pair) => pair.map(photo)),
        ),
      }),
    },
  );
}

// A reply ends complete or stopped at a limit; one that failed ends its
// chat, which then takes no message, so none does here. It says something,
// or it would have failed.
const reply = fc.record({
  stopped: fc.constantFrom(null, null, "timeout"),
  text: text.map((words) => `r${words}`),
});

// One chat with what happens to it: plain ones carry small media, heavy ones
// enough to be compacted for, and compacted ones are compacted on request
// before the next message.
const scenario = (kind) =>
  fc.record({
    kind: fc.constant(kind),
    exchanges: fc.array(fc.record({ turn: turn(kind === "heavy"), reply }), {
      minLength: 1,
      maxLength: 8,
    }),
    compactedTo: piece.map((words) => `${words}x`),
    next: piece,
  });

const SUMMARY_ASKED = "Stop here and don’t reply";
// A workspace whose summaries say `summary`, whose seeded replies are
// `script`'s next, and whose last reply goes through the real encoder to a
// fetch that records the body it is sent.
async function harness(store, summary) {
  const script = [];
  const sent = [];
  const bodies = [];
  const fetcher = async (_url, options) => {
    bodies.push(options.body);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const controller = await workspace({
    store,
    openAt: null,
    reply: async (messages, request, signal, onText) => {
      const last = messages.at(-1);
      if (last.role === "user" && last.text.startsWith(SUMMARY_ASKED))
        return {
          text: summary,
          model: request.model,
          usage: NO_USAGE,
          stopped: null,
        };
      const next = script.shift();
      if (next)
        return {
          text: next.text,
          model: request.model,
          usage: NO_USAGE,
          stopped: next.stopped,
        };
      sent.push(messages);
      return completeReply(messages, request, signal, onText, fetcher);
    },
  });
  return { controller, script, sent, bodies };
}

// Resolves once the open chat is ready again, or fails after a while.
async function settled(controller) {
  for (let turns = 0; turns < 10_000; turns++) {
    await tick();
    const chat = openChat(controller);
    if (chat.phase.kind === "ready" && chat.saving === null) return;
  }
  throw new Error(
    `The chat never settled: ${openChat(controller).phase.kind}.`,
  );
}

// Sends one turn as the composer does: photos through the draft.
async function sendTurn(controller, turn) {
  if (turn.kind === "audio") return controller.sendAudio(turn.audio);
  const draft = controller.state.getState().draft;
  if (turn.photos.length) await draft.addPhotos(turn.photos);
  return controller.send(turn.text, await draft.readPhotos());
}

const utf8 = (text) => Buffer.from(text, "utf8");
function sameText(actual, expected, where) {
  assert.equal(typeof actual, "string", where);
  assert.equal(actual, expected, where);
  assert.ok(utf8(actual).equals(utf8(expected)), `${where}: UTF-8 bytes`);
}

// The request view of the messages a request is made of against the body
// the request put on the wire: every text it shows is the body's string,
// unchanged, and the copied transcript gives the same strings back.
function assertShownIsSent(sentMessages, body) {
  const wire = JSON.parse(body).messages;
  const shown = shownRequest(sentMessages);
  const copied = JSON.parse(requestTranscript(shown));
  assert.equal(shown.length, wire.length);
  assert.equal(copied.length, wire.length);
  wire.forEach((message, index) => {
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    assert.equal(shown[index].role, message.role);
    assert.equal(copied[index].role, message.role);
    assert.equal(shown[index].parts.length, parts.length);
    assert.equal(copied[index].content.length, parts.length);
    parts.forEach((part, at) => {
      const view = shown[index].parts[at];
      const copy = copied[index].content[at];
      const where = `message ${index} part ${at}`;
      if (part.type === "text") {
        assert.equal(view.kind, "text", where);
        sameText(view.text, part.text, `${where} shown`);
        sameText(copy.text, part.text, `${where} copied`);
      } else if (part.type === "image_url") {
        assert.equal(view.kind, "photo", where);
        assert.equal(view.url, part.image_url.url, where);
        const data = part.image_url.url.split(",")[1];
        assert.equal(view.bytes, Buffer.from(data, "base64").length, where);
        assert.deepEqual(copy, { type: "image", bytes: view.bytes }, where);
      } else {
        assert.equal(view.kind, "recording", where);
        assert.equal(view.format, part.input_audio.format, where);
        const bytes = Buffer.from(part.input_audio.data, "base64").length;
        assert.equal(view.bytes, bytes, where);
        assert.deepEqual(
          copy,
          { type: "audio", format: view.format, bytes },
          where,
        );
      }
    });
  });
  return wire;
}

async function check(scenario) {
  const { store, sqlite } = connect();
  await store.initialize();
  const { controller, script, sent, bodies } = await harness(
    store,
    scenario.compactedTo,
  );
  try {
    for (const { turn, reply } of scenario.exchanges) {
      script.push(reply);
      const taken = await sendTurn(controller, turn);
      assert.equal(taken, "saved", String(controller.state.getState().error));
      await settled(controller);
    }
    assert.equal(script.length, 0);
    if (scenario.kind === "compacted") {
      assert.equal(controller.command({ kind: "compact" }), null);
      await settled(controller);
      assert.equal(openChat(controller).log.at(-1).kind, "compaction");
    }
    const taken = await sendTurn(controller, {
      kind: "text",
      text: `next ${scenario.next}`,
      photos: [],
    });
    assert.equal(taken, "saved", String(controller.state.getState().error));
    await settled(controller);
    assert.equal(sent.length, 1);
    const wire = assertShownIsSent(sent[0], bodies[0]);
    // The view of the log up to the last reply is what that reply was sent.
    const log = openChat(controller).log;
    assert.deepEqual(await controller.shownFrom(log, log.length - 2), sent[0]);
    const compaction = log.findLast((entry) => entry.kind === "compaction");
    if (compaction) {
      assert.equal(wire[0].role, "system");
      sameText(
        wire[0].content,
        `${SUMMARY_HEADING}${compaction.summary.text}`,
        "summary",
      );
    }
    if (scenario.kind === "compacted")
      assert.equal(compaction.summary.text, scenario.compactedTo.trim());
  } finally {
    await controller.dispose();
    sqlite.close();
  }
}

for (const kind of ["plain", "heavy", "compacted"])
  test(`the request view shows exactly what a request sends: ${kind} chats`, async () => {
    await fc.assert(fc.asyncProperty(scenario(kind), check), {
      seed: SEED,
      numRuns: RUNS[kind],
    });
  });
