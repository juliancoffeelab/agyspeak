import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

// Compiles src/migrations/ alone, without the app's ambient types, and fails
// if the compilation reaches any file outside the boundary or packages.
const root = resolve(import.meta.dirname, "..");
const tsc = ["exec", "tsc", "-p", "tsconfig.migrations.json"];
const leaks = execFileSync("pnpm", [...tsc, "--listFilesOnly"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .map((file) => relative(root, file))
  .filter(
    (file) =>
      !file.startsWith("src/migrations/") && !file.includes("node_modules/"),
  );
if (leaks.length) {
  console.error("Migration compilation reached:\n" + leaks.join("\n"));
  process.exit(1);
}
try {
  execFileSync("pnpm", tsc, { cwd: root, stdio: "inherit" });
} catch {
  process.exit(1);
}
