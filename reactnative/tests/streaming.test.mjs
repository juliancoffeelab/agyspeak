import assert from "node:assert/strict";
import test from "node:test";
import { completeReply } from "../src/providers/openrouter/transport.ts";

const settings = {
  apiKey: "sk-or-test-never-sent",
  model: "test/model",
  maxTokens: 27_000,
};
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
    stopped: null,
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
      assert.match(error.message, /request was rate limited/);
      assert.match(error.message, /Upstream rate limited/);
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

test("a reply cut off at the output limit keeps its text and says why", async () => {
  const sse =
    frame(delta("Half an ans")) +
    frame({ choices: [{ delta: {}, finish_reason: "length" }] }) +
    "data: [DONE]\n\n";
  const result = await completeReply(
    messages,
    settings,
    new AbortController().signal,
    () => {},
    async () => bytesResponse(sse),
  );
  assert.deepEqual(result, {
    text: "Half an ans",
    model: "test/model",
    cost: null,
    stopped: "length",
  });
});

// The body stays open until the request is aborted, as a stalled reply does.
function stalled(options, onOpen) {
  return new Response(
    new ReadableStream({
      start(controller) {
        options.signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        onOpen(controller);
      },
    }),
  );
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("silence ends a reply as timed out; stream events, not keep-alives, postpone it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stream;
  const task = completeReply(
    messages,
    settings,
    new AbortController().signal,
    () => {},
    async (_url, options) =>
      stalled(options, (controller) => {
        stream = controller;
      }),
  );
  await tick();
  const send = async (text) => {
    stream.enqueue(new TextEncoder().encode(text));
    await tick();
  };
  t.mock.timers.tick(100_000);
  await send(frame(delta("Thinking done. ")));
  t.mock.timers.tick(100_000);
  await send(": OPENROUTER PROCESSING\n\n");
  t.mock.timers.tick(19_999);
  await tick();
  let settled = false;
  void task.then(() => (settled = true));
  await tick();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await task, {
    text: "Thinking done. ",
    model: "test/model",
    cost: null,
    stopped: "timeout",
  });
});

test("a reply that keeps streaming still ends at the overall time limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stream;
  const task = completeReply(
    messages,
    settings,
    new AbortController().signal,
    () => {},
    async (_url, options) =>
      stalled(options, (controller) => {
        stream = controller;
      }),
  );
  await tick();
  for (let elapsed = 0; elapsed < 600_000; elapsed += 60_000) {
    stream.enqueue(new TextEncoder().encode(frame(delta("more "))));
    await tick();
    t.mock.timers.tick(60_000);
  }
  const result = await task;
  assert.equal(result.stopped, "timeout");
  assert.equal(result.text, "more ".repeat(10));
});

test("a request or body read the platform rejects is a lost connection, keeping the cause", async () => {
  const refused = new Error("fetch failed: any platform wording");
  await assert.rejects(
    completeReply(
      messages,
      settings,
      new AbortController().signal,
      () => {},
      async () => {
        throw refused;
      },
    ),
    (error) => {
      assert.match(error.message, /Couldn’t reach OpenRouter/);
      assert.equal(error.cause, refused);
      return true;
    },
  );
  const dropped = new Error("socket closed");
  const updates = [];
  await assert.rejects(
    completeReply(
      messages,
      settings,
      new AbortController().signal,
      (text) => updates.push(text),
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(frame(delta("Part"))),
              );
            },
            pull(controller) {
              controller.error(dropped);
            },
          }),
        ),
    ),
    (error) => {
      assert.match(error.message, /Couldn’t reach OpenRouter/);
      assert.equal(error.cause, dropped);
      return true;
    },
  );
  assert.deepEqual(updates, ["Part"]);
});
