---
name: save-migrations
description: Use when changing or auditing React Native persisted formats, SQLite schema upgrades, settings migrations, historical fixtures, or migration dependencies and loading integration.
---

# Save migrations

**Cornerstone rule: historical compatibility belongs only in explicit,
version-to-version migrations inside a closed dependency boundary.** Normal
application code reads and writes only current formats. Fix rejected historical
data in its migration, never through compatibility branches in ordinary readers,
defaults, controllers or startup recovery.

This skill governs the React Native app, independently of the Python CLI.
It does not authorize data deletion, dropping supported versions, or changing
historical meaning. Follow the user's requested scope.

## Supported versions

The chat database (`chat-history.db`) is the only durable store with a
version. Its **baseline** is the oldest supported version: older versions are
rejected unchanged. Every later version stays supported through its step;
steps and the baseline are permanent. [Version history](references/history.md)
names the baseline and records each version's declared changes. Preferences
live in the database's `preferences` table and migrate with it. SecureStore
holds only the API key, in its current format, with no conversion.

## One pending step

A branch holds one **pending** version: the number after the last frozen
one. Every schema change on the branch edits that one module in
place, so a pull request merges at most one step, whatever number of schema
changes it took to get there.

- **Freezing.** A version freezes when it merges to `main` or a release build
  containing it is installed, whichever comes first. A frozen module and its
  step are never edited again.
- **Pending databases are disposable.** After the pending step changes, a dev
  database already stamped with its version holds an outdated schema. Restore
  the copy from before the upgrade, `chat-history.db.before-upgrade` beside
  the database, and run the step again.
- **Merge check.** `git diff --name-status <base> -- reactnative/src/migrations/history`
  shows one added version module at most.

## Closed dependency boundary

Migration code lives under `reactnative/src/migrations/`. The boundary is closed
in both directions:

- **Outward:** migration files import only other files inside
  `src/migrations/` and declared pure libraries such as Zod. Application code
  is outside the boundary, including its types, validators, defaults and
  utilities, whether reached by type-only imports, re-exports, `import()` or
  `require`.
- **Inward:** application code imports only the entry module,
  `src/migrations/index.ts`. Version modules and their steps stay private.

Migrations are pure data conversion. Storage, SecureStore, network, React and
native Expo modules stay with the application: the runner,
`src/storage/historyMigration.ts`, reads the database's version, executes the
steps the entry module plans, and owns the transaction. Pure steps therefore
run under `node --test`.

**Shape.** `src/migrations/history/vN.ts` holds version N: its `version`, a Zod
row type for every table it changes (`rows`, `Rows`), and `upgrade`, the SQL
statements from N-1. The baseline module instead holds the full schema and
`create`, the statements for an empty database. A later version spreads the previous
module's `rows` and redefines only the tables it changes. The entry module
lists each step in `upgrades` and exports the last version as
`HISTORY_VERSION`, `historyRows` and `HistoryRows`. An empty database runs
the baseline's `create` followed by every step, so a fresh install and an upgraded one
reach the same schema.

Copy historical definitions deliberately; never alias or derive them from
today's application contracts.

**Enforcement.** Both checks already run:

- `eslint-rules/migration-boundary.mjs`, through `pnpm exec eslint .`,
  resolves every import, re-export, `import()` and `require` against the
  importing file and reports any that cross the boundary in either direction,
  including non-literal specifiers. If path aliases or symlinks under `src/`
  are added, the rule must resolve them too.
- `scripts/check-migrations.mjs`, through `pnpm typecheck`, compiles
  `tsconfig.migrations.json` alone and fails if the compilation reaches any
  file outside `src/migrations/` and `node_modules/`, which catches type leaks
  the lint rule cannot see.

## Historical contracts

Keep historical fixtures independent: do not initialize today's database and
remove columns to manufacture an older version. `tests/fixtures/history/` holds
one frozen database at the baseline with representative rows; never regenerate
it. Each step is tested by upgrading that fixture and comparing every table with the
fixture after applying only the step's declared change, and by parsing every
stored row with `historyRows[table].strict()`.

Changes to application types, defaults, model catalogs or validators must not
alter historical interpretation. Preserve durable messages, audio/photo bytes
and references, drafts, model selections and credentials. Define necessary
new-field values in the versioned conversion itself; reject malformed required
facts instead of inventing them. Document each intentional change, such as a
retired column, in the version's section of
[version history](references/history.md) and in that step's test.

## Disposable caches

Treat disposable caches separately from durable user data. An incompatible model
catalog cache is rejected and refetched; it does not get a migration that
invents missing capabilities. Never send inference to validate a storage
conversion.

## Workflow and completion

1. Inspect affected storage, callers and existing checks. Identify the durable
   facts the change touches. Read the sections of
   [version history](references/history.md) for the versions involved.
2. Before editing migration code, back up the Android dev database,
   `files/SQLite/chat-history.db*`, with `adb exec-out run-as <package> cat`.
   A running dev client reloads on save and applies the new chain to its
   database at once.
3. Add the pending version module and its step and register it in `upgrades`,
   or edit the pending one this branch already has, and move
   application queries to the new schema. Write its SQL by
   [SQLite integration](references/sqlite.md) and its section in version
   history. Keep storage I/O outside the boundary.
4. Verify offline through the real runner (`tests/sqlite-helper.mjs`): the
   upgrade from the baseline fixture with its declared change, fresh creation
   matching the upgraded schema, the current version opening unchanged,
   unsupported and future versions rejected unchanged, and a failing step
   rolling back.
5. Run `pnpm typecheck`, `pnpm exec eslint .`, `pnpm exec prettier --check .`
   and `pnpm test` after inspecting them for paid requests. Use in-memory or
   system-temp databases, never the user's live database or SecureStore.
6. Verify once on an Android dev build, since `node:sqlite` uses one
   connection and Expo does not. Install a database built from the fixture,
   launch, pull it back, compare it with the fixture, then restore the step 2
   backup byte for byte.

Complete when both boundary checks pass, the baseline fixture reaches the validated
current format with only declared changes, other input is explicitly rejected,
and a failed upgrade leaves the source data and version intact. Report the
supported paths, intentional changes, checks actually run and any unverified
behavior. A conversion returning success is not proof of a successful
persisted load.
