import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeReply,
  requestMessages,
} from "../src/providers/openrouter/transport.ts";
import {
  RECORDING_LEFT_OUT,
  replyRequest,
} from "../src/features/chat/runtime/log.ts";
import { providerMessages } from "../src/features/chat/runtime/chatRuntime.ts";
import {
  continueInstruction,
  loadTokenizer,
  replyTail,
  SUMMARY_HEADING,
} from "../src/features/chat/runtime/compaction.ts";
import { parseKeyInput } from "../src/providers/openrouter/key.ts";

// A reply's end is cut at a token boundary.
await loadTokenizer();

const MOCK_REQUEST_SETTINGS = {
  apiKey: "sk-or-v1-dummy-never-sent",
  model: "openrouter/free",
  sessionId: "0b5c2f3e-8d4a-4c1e-9f7a-2e6d1b3c5a90",
  maxTokens: 27_000,
};
const MOCK_USER_MESSAGE = {
  id: 1,
  role: "user",
  text: "Hello",
  status: "complete",
};
const signal = () => new AbortController().signal;

test("request is bounded, authenticated, and parsed without a live API call", async () => {
  const result = await completeReply(
    [MOCK_USER_MESSAGE],
    MOCK_REQUEST_SETTINGS,
    signal(),
    () => {},
    async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(
        options.headers.Authorization,
        `Bearer ${MOCK_REQUEST_SETTINGS.apiKey}`,
      );
      const body = JSON.parse(options.body);
      assert.equal(body.model, "openrouter/free");
      assert.equal(body.max_tokens, 27_000);
      assert.equal(body.stream, true);
      assert.equal(body.session_id, MOCK_REQUEST_SETTINGS.sessionId);
      assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
      return streamResponse("Hi!", "chosen/free-model", 0);
    },
  );
  assert.deepEqual(result, {
    text: "Hi!",
    model: "chosen/free-model",
    usage: {
      costUSD: 0,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
      cacheWritePromptTokens: null,
    },
    stopped: null,
  });
});

test("authentication/rate-limit and malformed responses fail without automatic retries", async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    await assert.rejects(
      completeReply(
        [MOCK_USER_MESSAGE],
        MOCK_REQUEST_SETTINGS,
        signal(),
        () => {},
        async () => {
          calls++;
          return new Response("", { status });
        },
      ),
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    completeReply(
      [MOCK_USER_MESSAGE],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async () => streamResponse(""),
    ),
    /no text/,
  );
});

const said = (text) => ({
  kind: "user",
  text,
  audio: null,
  photos: [],
  postedAt: null,
});
const wrote = (text, status = "complete") => ({
  kind: "reply",
  status,
  text,
  ending: null,
  providerMessage: null,
  model: null,
  usage: null,
  maxTokens: null,
  compaction: null,
  postedAt: null,
  elapsedMillis: null,
});
const compaction = (kept, instruction) => ({
  kind: "compaction",
  summary: { text: "They said hello.", tokens: 4, model: "test/model" },
  kept,
  pass: "final",
  instruction,
});

test("context is the summary, what it keeps, then every entry after the compaction, with no text budget", () => {
  const long = "long".repeat(7000);
  const sent = (log) =>
    requestMessages(
      replyRequest(log).map(({ role, text }) => ({ role, text })),
    );
  const before = [said("Compacted"), wrote("Compacted too")];
  assert.deepEqual(
    sent([
      ...before,
      compaction([], null),
      said("Older"),
      wrote(long),
      said("Hello"),
    ]),
    [
      { role: "system", content: `${SUMMARY_HEADING}They said hello.` },
      { role: "user", content: "Older" },
      { role: "assistant", content: long },
      { role: "user", content: "Hello" },
    ],
  );
  // A reply cut while it was written: its compaction keeps its end and asks
  // for the rest, which follows as the next part.
  const cut = long.length - 3;
  const tail = replyTail(long.slice(0, cut));
  const instruction = continueInstruction({ shown: "end", at: "mid-text" });
  assert.deepEqual(
    sent([
      ...before,
      said("Older"),
      wrote(long.slice(0, cut), "cut"),
      compaction(
        [[{ entry: 3, from: cut - tail.length, to: cut }]],
        instruction,
      ),
      wrote(long.slice(cut)),
      said("Hello"),
    ]),
    [
      { role: "system", content: `${SUMMARY_HEADING}They said hello.` },
      { role: "assistant", content: tail },
      { role: "user", content: instruction },
      { role: "assistant", content: long.slice(cut) },
      { role: "user", content: "Hello" },
    ],
  );
  assert.equal(sent([...before, said("Hello")]).length, 3);
});

test("aborting propagates to the transport", async () => {
  const controller = new AbortController();
  const task = completeReply(
    [MOCK_USER_MESSAGE],
    MOCK_REQUEST_SETTINGS,
    controller.signal,
    () => {},
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
});

test("QR and clipboard key formats are validated without executing links or accepting arbitrary QR data", () => {
  const key = "sk-or-v1-dummy-valid-key-for-tests";
  assert.equal(parseKeyInput(`  ${key}\n`), key);
  assert.equal(parseKeyInput(`Bearer ${key}`), key);
  assert.equal(
    parseKeyInput(
      JSON.stringify({ type: "agyspeak.openrouter-key", version: 1, key }),
    ),
    key,
  );
  assert.throws(() => parseKeyInput("https://example.com"));
  assert.throws(() => parseKeyInput('{"type":"unrelated","key":"secret"}'));
});

test("provider errors retain actionable details and redact credentials", async () => {
  await assert.rejects(
    completeReply(
      [MOCK_USER_MESSAGE],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async () =>
        Response.json(
          {
            error: {
              message: "Provider rejected request",
              metadata: {
                raw: JSON.stringify({
                  error: {
                    message: `Unsupported parameter; key ${MOCK_REQUEST_SETTINGS.apiKey}`,
                  },
                }),
              },
            },
          },
          { status: 400 },
        ),
    ),
    (error) => {
      assert.match(error.message, /Unsupported parameter/);
      assert.ok(!error.message.includes(MOCK_REQUEST_SETTINGS.apiKey));
      assert.match(error.message, /redacted/);
      return true;
    },
  );
});

test("a 429 is reported as rate limited, with the provider's own detail and no guess at whose limit", async () => {
  await assert.rejects(
    completeReply(
      [MOCK_USER_MESSAGE],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async () =>
        Response.json(
          {
            error: {
              message: "Provider returned error",
              metadata: {
                raw: JSON.stringify({
                  error: { message: "temporarily rate-limited upstream" },
                }),
              },
            },
          },
          { status: 429 },
        ),
    ),
    (error) => {
      assert.match(
        String(error),
        /^Error: The request was rate limited\. Try again later\. Provider returned error temporarily rate-limited upstream$/,
      );
      assert.equal(
        error.providerMessage,
        "Provider returned error temporarily rate-limited upstream",
      );
      return true;
    },
  );
  await assert.rejects(
    completeReply(
      [MOCK_USER_MESSAGE],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async () => new Response("", { status: 429 }),
    ),
    (error) => {
      assert.match(
        String(error),
        /^Error: The request was rate limited\. Try again later\.$/,
      );
      assert.equal(error.providerMessage, null);
      return true;
    },
  );
});

test("audio sends only the recording and reads an ordinary text answer", async () => {
  const audio = {
    data: "UklGRg==",
    format: "m4a",
    durationMillis: 3000,
    levels: [0.1, 0.8],
  };
  const result = await completeReply(
    [{ ...MOCK_USER_MESSAGE, text: "Voice message", audio }],
    { ...MOCK_REQUEST_SETTINGS, model: "google/gemini-3.8-flash" },
    signal(),
    () => {},
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "google/gemini-3.8-flash");
      assert.deepEqual(body.messages, [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: audio.data, format: audio.format },
            },
          ],
        },
      ]);
      assert.equal(body.response_format, undefined);
      assert.deepEqual(body.reasoning, { effort: "low" });
      return streamResponse("Hej!", MOCK_REQUEST_SETTINGS.model, 0.001);
    },
  );
  assert.equal(result.text, "Hej!");
  assert.equal(result.usage.costUSD, 0.001);
});

test("invalid audio never reaches the network", async () => {
  await assert.rejects(
    completeReply(
      [{ ...MOCK_USER_MESSAGE, audio: { data: "", format: "exe" } }],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async () => {
        assert.fail("invalid audio must never reach the network");
      },
    ),
  );
});

test("text follow-ups preserve earlier audio context and honor the selected model", async () => {
  const audio = { data: "UklGRg==", format: "wav" };
  const history = [
    { ...MOCK_USER_MESSAGE, audio },
    { ...MOCK_USER_MESSAGE, id: 2, role: "assistant", text: "Hello!" },
    { ...MOCK_USER_MESSAGE, id: 3, text: "What did I say?" },
  ];
  await completeReply(
    history,
    MOCK_REQUEST_SETTINGS,
    signal(),
    () => {},
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, MOCK_REQUEST_SETTINGS.model);
      assert.deepEqual(body.messages[0].content, [
        { type: "input_audio", input_audio: audio },
      ]);
      assert.equal(body.messages[2].content, "What did I say?");
      return streamResponse("You said hello.");
    },
  );
});

test("retained audio is bounded independently of text, and older recordings leave a placeholder", async () => {
  const data = "A".repeat(8 * 1024 * 1024);
  const log = [1, 2, 3].map((key) => ({
    ...said("Hello"),
    audio: {
      key: String(key),
      format: "wav",
      encodedLength: data.length,
      durationMillis: null,
      levels: null,
    },
  }));
  const read = [];
  const sent = requestMessages(
    await providerMessages(replyRequest(log), async (keys) => {
      read.push(...keys);
      return new Map(keys.map((key) => [key, data]));
    }),
  );
  assert.equal(sent.length, 3);
  assert.ok(sent[0].content.endsWith(RECORDING_LEFT_OUT));
  assert.deepEqual(read, ["2", "3"], "a recording left out isn't read");
  for (const message of sent.slice(1))
    assert.equal(message.content[0].type, "input_audio");
});

test("incompatible selected models surface a provider error without a model switch or retry", async () => {
  let calls = 0;
  await assert.rejects(
    completeReply(
      [{ ...MOCK_USER_MESSAGE, audio: { data: "UklGRg==", format: "wav" } }],
      MOCK_REQUEST_SETTINGS,
      signal(),
      () => {},
      async (_url, options) => {
        calls++;
        assert.equal(
          JSON.parse(options.body).model,
          MOCK_REQUEST_SETTINGS.model,
        );
        return Response.json(
          { error: { message: "This model does not support audio input." } },
          { status: 400 },
        );
      },
    ),
    /does not support audio/,
  );
  assert.equal(calls, 1);
});

function streamResponse(
  text,
  model = MOCK_REQUEST_SETTINGS.model,
  cost = null,
) {
  return new Response(
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }], usage: { cost } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
