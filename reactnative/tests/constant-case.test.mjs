import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { constantCaseRule } from "../eslint-rules/constant-case.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const TESTER = new RuleTester({
  languageOptions: { parser: tseslint.parser, sourceType: "module" },
});
const NO_EXPORTS = [{ allowExports: [], note: "" }];
const ALLOW_VERSION = [{ allowExports: ["version"], note: "" }];
const flagged = (code, name) => ({
  code,
  options: NO_EXPORTS,
  errors: [{ messageId: "constant", data: { name, note: "" } }],
});

TESTER.run("constant-case", constantCaseRule, {
  valid: [
    {
      code: `
        const DAY_MILLIS = 24 * 60 * 60 * 1000;
        const rows = { chats: z.object({}) };
        const queryClient = new QueryClient();
        const storage = { limit: 1, read() { return null; } };
        const sizes = [width, 2];`,
      options: NO_EXPORTS,
    },
    {
      code: `
        let count = 0;
        const { a, b } = { a: 1, b: 2 };
        function f() { const local = 1; return local; }`,
      options: NO_EXPORTS,
    },
    { code: "export const version = 16;", options: ALLOW_VERSION },
  ],
  invalid: [
    flagged("const limit = 4_000;", "limit"),
    flagged("const pattern = /^a+$/u;", "pattern"),
    flagged("export const palettes = { light: { bg: '#fff' } };", "palettes"),
    flagged("const flags = [1, [2, 3], ...[4]];", "flags"),
    flagged("const tight = { a: 1 } as const;", "tight"),
    flagged("const fixed = Object.freeze({ a: 1 });", "fixed"),
    flagged("const below = -1 + 2 * 3;", "below"),
    flagged("const nested = { a: A_B, ...BASE };", "nested"),
    // Only the export is required; a local `version` is still data.
    { ...flagged("const version = 16;", "version"), options: ALLOW_VERSION },
  ],
});
