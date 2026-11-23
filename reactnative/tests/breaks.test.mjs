import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanBreak,
  endsBlock,
  splitAt,
  tailStart,
} from "../src/features/chat/runtime/breaks.ts";

// A text whose last block, `unfinished`, follows `kept`, with `from` placed
// so the look-back reaches back over the last block.
const cut = (kept, unfinished) => {
  const text = kept + unfinished;
  return text.slice(0, cleanBreak(text, 0));
};
const long = (words) => " word".repeat(words).trim();

test("a cut drops the unfinished last block back to the blank line before it", () => {
  const kept = `${long(40)}\n\n${long(40)}\n\n`;
  assert.equal(cut(kept, long(10)), kept);
});

test("a cut never follows a heading: it goes before the heading", () => {
  const before = `${long(100)}\n\n`;
  assert.equal(cut(`${before}## A heading\n\n`, long(10)), before);
  assert.equal(cut(`${before}## A heading\n`, long(10)), before);
});

test("a blank line in a fenced code block isn't a break", () => {
  const code = "```js\nconst a = 1;\n\nconst b = 2;\n";
  // The break before the fence is in reach: the unfinished fence is dropped.
  const near = `${long(40)}\n\n`;
  assert.equal(cut(near, `${code}const c`), near);
  // Out of reach, the cut falls back to a line end in the fence.
  const far = `${long(100)}\n\n\`\`\`js\n${"const a = 1;\n".repeat(20)}\nconst b = 2;\n`;
  assert.equal(cut(far, "const c"), far);
});

test("a cut looks back only over part of what the request wrote, then falls back to a line end, else the raw cut", () => {
  // The only blank line is in what earlier requests wrote.
  const earlier = `${long(40)}\n\n`;
  const written = `${long(200)}\n${long(5)}`;
  const text = earlier + written;
  assert.equal(
    text.slice(0, cleanBreak(text, earlier.length)),
    `${earlier}${long(200)}\n`,
  );
  const unbroken = earlier + long(200);
  assert.equal(cleanBreak(unbroken, earlier.length), unbroken.length);
});

test("a part split inside a fence opens it again and the part before closes it", () => {
  const text = "Text\n\n```js\nconst a = 1;\nconst b = 2;\n";
  const at = text.indexOf("const b");
  const [first, second] = splitAt(text, [at]);
  assert.equal(first, "Text\n\n```js\nconst a = 1;\n```");
  assert.equal(second, "```js\nconst b = 2;\n");
  // Outside a fence, the parts are the text's own.
  const plain = "One.\n\nTwo.\n\nThree.";
  const cuts = [plain.indexOf("Two"), plain.indexOf("Three")];
  assert.deepEqual(splitAt(plain, cuts), ["One.\n\n", "Two.\n\n", "Three."]);
});

test("a tail starts at the earliest clean break whose rest fits", () => {
  const text = `${long(40)}\n\n${long(4)}\n\n${long(4)}`;
  const fits = (tail) => tail.length <= 60;
  assert.equal(text.slice(tailStart(text, fits)), `${long(4)}\n\n${long(4)}`);
  // Without a break that fits, the latest place whose rest does.
  const unbroken = long(40);
  const start = tailStart(unbroken, fits);
  assert.ok(fits(unbroken.slice(start)) && !fits(unbroken.slice(start - 1)));
  assert.equal(tailStart("short", fits), 0);
  // A text cut at a clean break ends in blank lines; when its last paragraph
  // is longer than fits, the end is that paragraph's, not the blank lines.
  const paragraph = `${long(4)}\n\n${long(40)}\n\n`;
  const end = paragraph.slice(tailStart(paragraph, fits));
  assert.ok(fits(end) && end.trim() && paragraph.endsWith(end));
});

test("a text ends a block after a blank line outside a code block, or when it is empty", () => {
  assert.equal(endsBlock(""), true);
  assert.equal(endsBlock("One paragraph.\n\n"), true);
  assert.equal(endsBlock("One paragraph."), false);
  assert.equal(endsBlock("One line.\n"), false);
  assert.equal(endsBlock("```\ncode\n\n"), false);
  assert.equal(endsBlock("```\ncode\n```\n\n"), true);
});
