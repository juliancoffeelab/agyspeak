import assert from "node:assert/strict";
import test from "node:test";
import { completeReply } from "../src/chat/openRouter.ts";

const settings = { apiKey: "sk-or-test-never-sent", model: "test/model" };
const messages = [{ id: 1, role: "user", text: "Hello", status: "complete" }];
function frame(data) {
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}
function delta(content) {
  return { choices: [{ delta: { content } }] };
}
function bytesResponse(text, cancelled = () => {}) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
      cancel: cancelled,
    }),
  );
}

test("SSE handles byte boundaries, CRLF, comments, Unicode, reasoning, and terminal usage", async () => {
  const updates = [];
  const sse =
    ": OPENROUTER PROCESSING\r\n\r\n" +
    frame({
      model: "actual/model",
      choices: [{ delta: { role: "assistant", reasoning: "private" } }],
    }) +
    frame(delta("Hej ")) +
    frame(delta("å😀!")) +
    frame({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { cost: 0.0002 },
    }) +
    "data: [DONE]\r\n\r\n";
  const result = await completeReply(
    messages,
    settings,
    new AbortController().signal,
    (text) => updates.push(text),
    async () => bytesResponse(sse),
  );
  assert.deepEqual(updates, ["Hej ", "Hej å😀!"]);
  assert.deepEqual(result, {
    text: "Hej å😀!",
    model: "actual/model",
    cost: 0.0002,
  });
});

test("text arrives before the response finishes; final metadata is consumed before DONE", async () => {
  let stream;
  let received;
  const first = new Promise((resolve) => {
    received = resolve;
  });
  const response = new Response(
    new ReadableStream({
      start(controller) {
        stream = controller;
      },
    }),
  );
  let complete = false;
  const task = completeReply(
    messages,
    settings,
    new AbortController().signal,
    (text) => received(text),
    async () => response,
  ).then((value) => {
    complete = true;
    return value;
  });
  stream.enqueue(new TextEncoder().encode(frame(delta("Early text"))));
  assert.equal(await first, "Early text");
  assert.equal(complete, false);
  stream.enqueue(
    new TextEncoder().encode(
      frame({ choices: [], usage: { cost: 0.001 } }) + "data: [DONE]\n\n",
    ),
  );
  assert.equal((await task).cost, 0.001);
});

test("truncated and malformed streams fail once, retaining already delivered text", async () => {
  for (const ending of ["", "data: {broken}\n\n"]) {
    const updates = [];
    let calls = 0;
    await assert.rejects(
      completeReply(
        messages,
        settings,
        new AbortController().signal,
        (text) => updates.push(text),
        async () => {
          calls++;
          return bytesResponse(frame(delta("Partial")) + ending);
        },
      ),
      /ended early|invalid response stream/,
    );
    assert.deepEqual(updates, ["Partial"]);
    assert.equal(calls, 1);
  }
});

test("mid-stream provider errors are actionable and redact credentials", async () => {
  const sse =
    frame(delta("Partial")) +
    frame({
      error: { code: 429, message: `Upstream rate limited ${settings.apiKey}` },
    });
  await assert.rejects(
    completeReply(
      messages,
      settings,
      new AbortController().signal,
      () => {},
      async () => bytesResponse(sse),
    ),
    (error) => {
      assert.match(error.message, /model provider is rate limited/);
      assert.ok(!error.message.includes(settings.apiKey));
      return true;
    },
  );
});

test("aborting an in-flight body stops reading and further text callbacks", async () => {
  const abort = new AbortController();
  const updates = [];
  const task = completeReply(
    messages,
    settings,
    abort.signal,
    (text) => {
      updates.push(text);
      abort.abort();
    },
    async (_url, options) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            options.signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            controller.enqueue(
              new TextEncoder().encode(
                frame(delta("First")) + frame(delta("Late")),
              ),
            );
          },
        }),
      );
    },
  );
  await assert.rejects(task);
  assert.deepEqual(updates, ["First"]);
});
