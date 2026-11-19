import assert from "node:assert/strict";
import test from "node:test";
import { formatError } from "../src/ui/formatError.ts";

test("error details keep every cause with its stack", () => {
  const inner = Object.assign(new TypeError("disk unreadable"), {
    code: "ERR_SQLITE",
  });
  const outer = new Error("Could not read chats", { cause: inner });
  const details = formatError(outer);
  assert.match(
    details,
    /^Error: Could not read chats\n\s+at .*\n[\s\S]*Caused by: TypeError \[ERR_SQLITE\]: disk unreadable\n\s+at /,
  );
  assert.equal(formatError("plain"), "plain");
  const loop = new Error("loop");
  loop.cause = loop;
  assert.equal(formatError(loop).match(/loop/g).length, 1);
});
