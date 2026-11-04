import assert from "node:assert/strict";
import { test } from "node:test";
import { completeReply, requestMessages } from "../src/chat/openRouter.ts";
import { parseKeyInput, decodeSettings } from "../src/chat/settings.ts";

const settings = {
  apiKey: "sk-or-v1-dummy-never-sent",
  model: "openrouter/free",
};
const user = { id: 1, role: "user", text: "Hello", status: "complete" };
const signal = () => new AbortController().signal;

test("request is bounded, authenticated, and parsed without a live API call", async () => {
  const result = await completeReply(
    [user],
    settings,
    signal(),
    () => {},
    async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(options.headers.Authorization, `Bearer ${settings.apiKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "openrouter/free");
      assert.equal(body.max_tokens, 512);
      assert.equal(body.stream, true);
      assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
      return streamResponse("Hi!", "chosen/free-model", 0);
    },
  );
  assert.deepEqual(result, {
    text: "Hi!",
    model: "chosen/free-model",
    cost: 0,
  });
});

test("authentication/rate-limit and malformed responses fail without automatic retries", async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    await assert.rejects(
      completeReply(
        [user],
        settings,
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
      [user],
      settings,
      signal(),
      () => {},
      async () => streamResponse(""),
    ),
    /no text/,
  );
});

test("context excludes unfinished replies and is limited to recent text", () => {
  const history = [
    { ...user, text: "old".repeat(9000) },
    user,
    { ...user, role: "assistant", text: "Failure", status: "failed" },
    { ...user, role: "assistant", text: "", status: "pending" },
  ];
  assert.deepEqual(requestMessages(history), [
    { role: "user", content: "Hello" },
  ]);
});

test("aborting propagates to the transport", async () => {
  const controller = new AbortController();
  const task = completeReply(
    [user],
    settings,
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
  assert.equal(decodeSettings(null).model, "openrouter/free");
  assert.throws(() => decodeSettings('{"apiKey":123}'));
});

test("provider errors retain actionable details and redact credentials", async () => {
  await assert.rejects(
    completeReply(
      [user],
      settings,
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
                    message: `Unsupported parameter; key ${settings.apiKey}`,
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
      assert.ok(!error.message.includes(settings.apiKey));
      assert.match(error.message, /redacted/);
      return true;
    },
  );
});

test("429 errors distinguish upstream provider limits from unspecified rate limits", async () => {
  await assert.rejects(
    completeReply(
      [user],
      settings,
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
    /model provider is rate limited/,
  );
  await assert.rejects(
    completeReply(
      [user],
      settings,
      signal(),
      () => {},
      async () => new Response("", { status: 429 }),
    ),
    /request was rate limited/,
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
    [{ ...user, text: "Voice message", audio }],
    { ...settings, model: "google/gemini-3.8-flash" },
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
      return streamResponse("Hej!", settings.model, 0.001);
    },
  );
  assert.equal(result.text, "Hej!");
  assert.equal(result.cost, 0.001);
});

test("invalid audio never reaches the network", async () => {
  await assert.rejects(
    completeReply(
      [{ ...user, audio: { data: "", format: "exe" } }],
      settings,
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
    { ...user, audio },
    { ...user, id: 2, role: "assistant", text: "Hello!" },
    { ...user, id: 3, text: "What did I say?" },
  ];
  await completeReply(
    history,
    settings,
    signal(),
    () => {},
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, settings.model);
      assert.deepEqual(body.messages[0].content, [
        { type: "input_audio", input_audio: audio },
      ]);
      assert.equal(body.messages[2].content, "What did I say?");
      return streamResponse("You said hello.");
    },
  );
});

test("retained audio context is bounded independently of text", () => {
  const large = { data: "A".repeat(8 * 1024 * 1024), format: "wav" };
  const history = [1, 2, 3].map((id) => ({ ...user, id, audio: large }));
  assert.equal(requestMessages(history).length, 2);
});

test("incompatible selected models surface a provider error without a model switch or retry", async () => {
  let calls = 0;
  await assert.rejects(
    completeReply(
      [{ ...user, audio: { data: "UklGRg==", format: "wav" } }],
      settings,
      signal(),
      () => {},
      async (_url, options) => {
        calls++;
        assert.equal(JSON.parse(options.body).model, settings.model);
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

function streamResponse(text, model = settings.model, cost = null) {
  return new Response(
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }], usage: { cost } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
