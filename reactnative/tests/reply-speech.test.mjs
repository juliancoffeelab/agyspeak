import assert from "node:assert/strict";
import test from "node:test";
import { PromiseSpeech } from "../src/chat/PromiseSpeech.ts";
import { SpeechSession } from "../src/chat/SpeechSession.ts";
import { markdownToSpeechText, speechChunks } from "../src/chat/speechText.ts";

function setup(stop = async () => {}, options = {}) {
  const spoken = [],
    errors = [];
  const { maxLength = 30, ...sessionOptions } = options;
  const playback = new PromiseSpeech({
    maxLength,
    stop,
    speak: (text, selection, callbacks) =>
      spoken.push({ text, selection, callbacks, ...callbacks }),
  });
  const speech = new SpeechSession({
    ...sessionOptions,
    stop: playback.stop,
    speak: playback.speak,
    onError: (message) => errors.push(message),
  });
  return { speech, spoken, errors, playback };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function start(speech, ...args) {
  void speech.toggle(...args);
  await tick();
}

test("spoken text keeps prose, inline code, link labels and Unicode without Markdown syntax or fenced code", () => {
  const source =
    "# Hello **world**\n\n- [a *nested* link](https://example.com/a_(b))\n- `value` &amp; svenska åäö\n\n```js\nsecretCode();\n```\n\n> Last paragraph.";
  const result = markdownToSpeechText(source);
  assert.match(result, /Hello world/);
  assert.match(result, /a nested link/);
  assert.match(result, /value & svenska åäö/);
  assert.match(result, /Last paragraph/);
  assert.doesNotMatch(result, /https:|secretCode|```|\*\*/);
  assert.equal(markdownToSpeechText("~~~python\nunfinished code"), "");
  assert.equal(markdownToSpeechText("    indented code"), "");
  assert.equal(
    markdownToSpeechText("<script>hidden()</script>\n\nReadable."),
    "Readable.",
  );
});

test("speech chunks fit the engine limit without dropping text or splitting emoji", () => {
  const source = "One short sentence. Another longer sentence. Final sentence.";
  assert.equal(speechChunks(source, 20).join(" "), source);
  assert.ok(speechChunks(source, 20).every((chunk) => chunk.length <= 20));
  const longWord = "a".repeat(28) + "🌈" + "b".repeat(20);
  assert.equal(speechChunks(longWord, 29).join(""), longWord);
  assert.ok(
    speechChunks(longWord, 29).every(
      (chunk) => !/[\uD800-\uDBFF]$/.test(chunk),
    ),
  );
});

test("switching responses cancels the old voice and ignores its late callbacks", async () => {
  const { speech, spoken, errors } = setup();
  await start(speech, 1, "First");
  await start(speech, 2, "Second");
  spoken[0].onDone();
  spoken[0].onError();
  spoken[0].onStopped();
  await tick();
  assert.equal(speech.getSnapshot().messageId, 2);
  assert.equal(spoken.length, 2);
  assert.deepEqual(errors, []);
  spoken[1].onDone();
  await tick();
  assert.equal(speech.getSnapshot().messageId, null);
});

test("Stop invalidates pending native startup and any queued chunk continuation", async () => {
  const stops = [];
  const { speech, spoken } = setup(
    () => new Promise((resolve) => stops.push(resolve)),
  );
  const starting = speech.toggle(1, "First");
  await tick();
  const stopping = speech.stop();
  stops.shift()();
  await starting;
  await tick();
  stops.shift()();
  await stopping;
  assert.equal(spoken.length, 0);
  assert.equal(speech.getSnapshot().messageId, null);
});

test("long speech advances one chunk at a time and cannot resume after Stop", async () => {
  const { speech, spoken } = setup();
  await start(
    speech,
    1,
    "A sentence long enough to need several chunks. Another sentence to finish.",
  );
  assert.equal(spoken.length, 1);
  spoken[0].onDone();
  await tick();
  assert.equal(spoken.length, 2);
  await speech.stop();
  spoken[1].onDone();
  await tick();
  assert.equal(spoken.length, 2);
  assert.equal(speech.getSnapshot().messageId, null);
});

test("voice failures clear playback; recording blocks speech until released", async () => {
  const { speech, spoken, errors } = setup();
  await start(speech, 1, "hello");
  spoken[0].onError();
  spoken[0].onError();
  await tick();
  assert.equal(speech.getSnapshot().messageId, null);
  assert.equal(errors.length, 1);
  speech.setRecording(true);
  await start(speech, 2, "blocked");
  assert.equal(spoken.length, 1);
  speech.setRecording(false);
  await start(speech, 2, "allowed");
  assert.equal(spoken.length, 2);
  await start(speech, 2, "allowed");
  assert.equal(speech.getSnapshot().messageId, null);
});

test("leaving an idle chat does not initialize the native speech engine", async () => {
  let stops = 0;
  const { speech } = setup(async () => {
    stops++;
  });
  assert.equal(await speech.stop(), true);
  assert.equal(stops, 0);
});

test("stopping during cold voice initialization cannot enqueue an utterance later", async () => {
  let ready;
  const preparation = new Promise((resolve) => {
    ready = resolve;
  });
  const spoken = [];
  const speech = new SpeechSession({
    prepare: () => preparation,
    stop: async () => {},
    speak: (text) => spoken.push(text),
    onError: () => {},
  });
  const start = speech.toggle(1, "Do not speak after Stop");
  await tick();
  await speech.stop();
  ready();
  await start;
  assert.deepEqual(spoken, []);
  assert.equal(speech.getSnapshot().messageId, null);
});

test("language choice stays with its response and reaches every speech chunk", async () => {
  const prepared = [];
  const { speech, spoken } = setup(undefined, {
    maxLength: 12,
    prepare: async (language) => {
      prepared.push(language);
      return { language, voice: `${language}-voice` };
    },
  });
  speech.setLanguage(1, "sv");
  speech.setLanguage(2, "uk");
  await start(speech, 1, "Hej på dig. Hur mår du idag?");
  spoken[0].callbacks.onDone();
  await tick();
  assert.ok(spoken.length > 1);
  assert.ok(
    spoken.every(
      (part) =>
        part.selection.language === "sv" && part.selection.voice === "sv-voice",
    ),
  );
  await start(speech, 2, "Привіт");
  assert.deepEqual(prepared, ["sv", "uk"]);
  assert.equal(spoken.at(-1).selection.language, "uk");
  assert.equal(speech.getSnapshot().languages.get(1), "sv");
});

test("changing language cancels pending initialization and never starts the old language", async () => {
  let ready;
  const preparation = new Promise((resolve) => {
    ready = resolve;
  });
  const spoken = [];
  const speech = new SpeechSession({
    stop: async () => {},
    prepare: () => preparation,
    speak: (text, callbacks, selection) => spoken.push(selection),
    onError: () => {},
  });
  speech.setLanguage(1, "en");
  const start = speech.toggle(1, "Hello");
  await tick();
  speech.setLanguage(1, "sv");
  ready({ language: "en", voice: "english" });
  await start;
  assert.equal(spoken.length, 0);
  assert.equal(speech.getSnapshot().messageId, null);
  assert.equal(speech.getSnapshot().languages.get(1), "sv");
});

test("voice matching uses the requested language and never silently picks English for Swedish", async () => {
  const { voiceForLanguage } = await import("../src/chat/speechLanguage.ts");
  const voices = [
    { language: "en-US", identifier: "english" },
    { language: "sv-SE", identifier: "swedish" },
    { language: "uk_UA", identifier: "ukrainian" },
  ];
  assert.equal(voiceForLanguage("sv", voices).identifier, "swedish");
  assert.equal(voiceForLanguage("uk", voices).identifier, "ukrainian");
  assert.equal(voiceForLanguage("sv", [voices[0]]), undefined);
});

test("language picker discovers and deduplicates every engine language, including regional variants", async () => {
  const { availableSpeechLanguages, voiceForLanguage } =
    await import("../src/chat/speechLanguage.ts");
  const voices = [
    { language: "en-US", identifier: "english-us" },
    { language: "en_US", identifier: "second-us-voice" },
    { language: "en-GB", identifier: "english-uk" },
    { language: "fr-FR", identifier: "french" },
    { language: "ja-JP", identifier: "japanese" },
    { language: "ar-EG", identifier: "arabic" },
    { language: "", identifier: "unknown" },
  ];
  const options = availableSpeechLanguages(voices);
  assert.deepEqual(options.map((option) => option.code).sort(), [
    "ar-EG",
    "en-GB",
    "en-US",
    "fr-FR",
    "ja-JP",
  ]);
  assert.ok(options.every((option) => option.label.length > 0));
  assert.equal(voiceForLanguage("en-GB", voices).identifier, "english-uk");
  assert.equal(voiceForLanguage("en-AU", voices), undefined);
});

test("Device default clears only the selected response's explicit language", async () => {
  const { speech } = setup();
  speech.setLanguage(1, "sv-SE");
  speech.setLanguage(2, "fr-FR");
  speech.setLanguage(1, undefined);
  assert.equal(speech.getSnapshot().languages.has(1), false);
  assert.equal(speech.getSnapshot().languages.get(2), "fr-FR");
});

test("language search matches English, native names, tags and small typos", async () => {
  const { availableSpeechLanguages, createSpeechLanguageSearch } =
    await import("../src/chat/speechLanguage.ts");
  const options = availableSpeechLanguages([
    { language: "sv-SE" },
    { language: "uk-UA" },
    { language: "de-DE" },
    { language: "es-ES" },
    { language: "ja-JP" },
    { language: "en-US" },
  ]);
  const search = createSpeechLanguageSearch(options);
  for (const query of [
    "Swedish",
    "Svenska",
    "sv-SE",
    "sv_SE",
    "swedsh",
    "svenksa",
  ])
    assert.equal(search(query)[0]?.code, "sv-SE", query);
  for (const query of ["Ukrainian", "українська", "uk-UA"])
    assert.equal(search(query)[0]?.code, "uk-UA", query);
  assert.equal(search("Deutsch")[0]?.code, "de-DE");
  assert.equal(search("espanol")[0]?.code, "es-ES");
  assert.equal(search("日本語")[0]?.code, "ja-JP");
  assert.deepEqual(search("   "), options);
  assert.deepEqual(search("zzzzzzzzzzzz"), []);
});

test("language names stay searchable when native Intl.DisplayNames is unavailable", async () => {
  const { availableSpeechLanguages, createSpeechLanguageSearch } =
    await import("../src/chat/speechLanguage.ts");
  const original = Object.getOwnPropertyDescriptor(Intl, "DisplayNames");
  Object.defineProperty(Intl, "DisplayNames", {
    configurable: true,
    value: undefined,
  });
  try {
    const options = availableSpeechLanguages([
      { language: "sv-SE" },
      { language: "uk-UA" },
      { language: "ja-JP" },
    ]);
    const search = createSpeechLanguageSearch(options);
    for (const query of ["Swedish", "Svenska", "sv-SE"])
      assert.equal(search(query)[0]?.code, "sv-SE", query);
    assert.equal(search("українська")[0]?.code, "uk-UA");
    assert.equal(search("日本語")[0]?.code, "ja-JP");
  } finally {
    if (original) Object.defineProperty(Intl, "DisplayNames", original);
    else Reflect.deleteProperty(Intl, "DisplayNames");
  }
});

test("session sends complete cleaned prose through one engine call", async () => {
  const calls = [];
  let finish;
  const speech = new SpeechSession({
    stop: async () => {},
    speak: (text, selection) => {
      calls.push({ text, selection });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    onError: () => assert.fail("Unexpected speech error"),
  });
  speech.setLanguage(1, "sv-SE");
  const text = "# Heading\n\n" + "A **long** response. ".repeat(300);
  const playing = speech.toggle(1, text);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, markdownToSpeechText(text));
  assert.ok(calls[0].text.length > 3000);
  assert.deepEqual(calls[0].selection, { language: "sv-SE" });
  assert.equal(speech.getSnapshot().messageId, 1);
  finish("finished");
  await playing;
  assert.equal(speech.getSnapshot().messageId, null);
});

test("failed native Stop is retried until successful before reporting speech idle", async () => {
  let stops = 0;
  let rejectStop = false;
  const { speech, errors } = setup(async () => {
    stops++;
    if (rejectStop) throw new Error("Native Stop failed");
  });
  await start(speech, 1, "Hello");
  assert.equal(stops, 1);
  rejectStop = true;
  assert.equal(await speech.stop(), false);
  assert.equal(speech.getSnapshot().messageId, null);
  assert.equal(await speech.stop(), false);
  assert.equal(stops, 3);
  rejectStop = false;
  assert.equal(await speech.stop(), true);
  assert.equal(stops, 4);
  assert.equal(await speech.stop(), true);
  assert.equal(stops, 4);
  assert.equal(errors.length, 2);
});

test("literal HTML in inline code survives the session's single Markdown cleanup", async () => {
  const { speech, spoken } = setup();
  await start(speech, 1, "Use `<button>` here.");
  assert.equal(spoken[0].text, "Use <button> here.");
  await speech.stop();
  await start(speech, 2, "`<button>`");
  assert.equal(spoken[1].text, "<button>");
  await speech.stop();
});
