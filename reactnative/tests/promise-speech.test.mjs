import assert from "node:assert/strict";
import test from "node:test";
import { PromiseSpeech } from "../src/chat/PromiseSpeech.ts";

function setup(stop = async () => {}, maxLength = 3000) {
  const jobs = [];
  const playback = new PromiseSpeech({
    maxLength,
    stop,
    speak: (text, selection, callbacks) =>
      jobs.push({ text, selection, ...callbacks }),
  });
  return { playback, jobs };
}

test("native completion and interruption produce distinct speech outcomes", async () => {
  const { playback, jobs } = setup();
  const finished = playback.speak("Hello", {
    language: "sv",
    voice: "swedish",
  });
  assert.deepEqual(jobs[0].selection, { language: "sv", voice: "swedish" });
  jobs[0].onDone();
  assert.equal(await finished, "finished");
  const stopped = playback.speak("Again");
  jobs[1].onStopped();
  assert.equal(await stopped, "stopped");
});

test("Stop settles speech even when native Stop never calls back or finishes", async () => {
  let finishStop;
  const { playback, jobs } = setup(
    () =>
      new Promise((resolve) => {
        finishStop = resolve;
      }),
  );
  const utterance = playback.speak("Hello");
  const stopping = playback.stop();
  assert.equal(await utterance, "stopped");
  jobs[0].onDone();
  jobs[0].onError();
  finishStop();
  await stopping;
});

test("late callbacks cannot settle a replacement utterance", async () => {
  const { playback, jobs } = setup();
  const first = playback.speak("First");
  await playback.stop();
  const second = playback.speak("Second");
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  jobs[0].onDone();
  jobs[0].onStopped();
  jobs[0].onError();
  await Promise.resolve();
  assert.equal(settled, false);
  jobs[1].onDone();
  assert.equal(await first, "stopped");
  assert.equal(await second, "finished");
});

test("native speech failures reject, while failed Stop still settles the utterance", async () => {
  const { playback, jobs } = setup(async () => {
    throw new Error("Stop failed");
  });
  const failure = playback.speak("Broken");
  const rejected = assert.rejects(failure, /Speech failed/);
  jobs[0].onError();
  await rejected;
  const stopped = playback.speak("Stop me");
  await assert.rejects(playback.stop(), /Stop failed/);
  assert.equal(await stopped, "stopped");
  const throwing = new PromiseSpeech({
    maxLength: 3000,
    stop: async () => {},
    speak: () => {
      throw new Error("Native failure");
    },
  });
  await assert.rejects(throwing.speak("Hello"), /Native failure/);
});

test("one speak promise covers every chunk with the same voice and native limit", async () => {
  const { playback, jobs } = setup(undefined, 18);
  const text = "First sentence. Second sentence. Third sentence.";
  const selection = { language: "sv-SE", voice: "swedish" };
  const result = playback.speak(text, selection);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  assert.equal(jobs.length, 1);
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(settled, false);
    assert.ok(jobs[index].text.length <= 18);
    assert.deepEqual(jobs[index].selection, selection);
    jobs[index].onDone();
    await Promise.resolve();
    if (index === 0) {
      // Duplicate/stale callbacks from the previous chunk cannot skip a chunk.
      jobs[index].onDone();
      jobs[index].onStopped();
      jobs[index].onError();
      assert.equal(jobs.length, 2);
    }
  }
  assert.ok(jobs.length > 1);
  assert.equal(jobs.map((job) => job.text).join(" "), text);
  assert.equal(await result, "finished");
});

test("Stop between chunks prevents enqueueing the next chunk", async () => {
  const { playback, jobs } = setup(undefined, 12);
  const result = playback.speak("First sentence. Second sentence.");
  jobs[0].onDone();
  const stopping = playback.stop();
  assert.equal(await result, "stopped");
  await stopping;
  assert.equal(jobs.length, 1);
});

test("native interruption or failure partway through text never advances again", async () => {
  for (const failure of [false, true]) {
    const { playback, jobs } = setup(undefined, 12);
    const result = playback.speak(
      "First sentence. Second sentence. Third sentence.",
    );
    const rejected = failure
      ? assert.rejects(result, /Speech failed/)
      : undefined;
    jobs[0].onDone();
    await Promise.resolve();
    if (failure) jobs[1].onError();
    else jobs[1].onStopped();
    if (failure) await rejected;
    else assert.equal(await result, "stopped");
    jobs[1].onDone();
    await Promise.resolve();
    assert.equal(jobs.length, 2);
  }
});
