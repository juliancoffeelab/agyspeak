import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// Keeps src/migrations/ closed in both directions. Migration files import only
// other migration files and the allowed packages; everything else imports only
// the entry module. Every import, re-export, import type, import() and
// require is resolved from the importing file; non-literal specifiers are
// reported because they cannot be checked.
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function resolve(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => path.join(base, "index" + extension)),
  ];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  // Real paths see through symlinks; an unresolved path is checked as written.
  return found ? realpathSync(found) : base;
}

export const migrationBoundaryRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep src/migrations/ a closed boundary." },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          packages: { type: "array", items: { type: "string" } },
        },
        required: ["root", "packages"],
        additionalProperties: false,
      },
    ],
    messages: {
      outward:
        "'{{source}}' leaves src/migrations/. Migrations import only migration files and {{packages}}.",
      inward:
        "'{{source}}' reaches inside src/migrations/. Import only src/migrations/index.ts.",
      dynamic: "Module specifiers must be string literals.",
    },
  },
  create(context) {
    const { root, packages } = context.options[0];
    const real = (p) => (existsSync(p) ? realpathSync(p) : p);
    const boundary = real(path.join(root, "src", "migrations"));
    const entry = path.join(boundary, "index.ts");
    const file = real(context.filename);
    const inside = (p) => p === boundary || p.startsWith(boundary + path.sep);
    const migration = inside(file);

    function check(node, source) {
      if (
        !source ||
        source.type !== "Literal" ||
        typeof source.value !== "string"
      ) {
        context.report({ node, messageId: "dynamic" });
        return;
      }
      const specifier = source.value;
      const relative = specifier.startsWith(".") || path.isAbsolute(specifier);
      if (migration) {
        const allowed = relative
          ? inside(resolve(file, specifier))
          : packages.includes(specifier);
        if (!allowed)
          context.report({
            node,
            messageId: "outward",
            data: { source: specifier, packages: packages.join(", ") },
          });
        return;
      }
      if (!relative) return;
      const target = resolve(file, specifier);
      if (inside(target) && target !== entry)
        context.report({
          node,
          messageId: "inward",
          data: { source: specifier },
        });
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) =>
        check(node, node.argument?.literal ?? node.argument),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node, node.arguments[0]);
      },
    };
  },
};
