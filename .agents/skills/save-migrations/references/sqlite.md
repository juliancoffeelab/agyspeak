# SQLite integration

Read before writing or changing a step's SQL, the runner
(`reactnative/src/storage/historyMigration.ts`) or startup recovery.

The runner reads `PRAGMA user_version`, rejects unsupported versions before
changing data, writes a complete copy of a populated database beside it as
`chat-history.db.before-upgrade`, and executes the complete ordered chain in one exclusive
transaction that no ordinary app work can touch until it finishes. It advances
the version with each step; failures roll back data and version together.

**Connection settings belong to the transaction's own connection.** Expo's
`withExclusiveTransactionAsync` opens a new connection and issues plain `BEGIN`
(not `BEGIN EXCLUSIVE`), so pragmas set on the main handle never reach it, and
the app does not set `foreign_keys` there. Write each step to be correct with
foreign keys on or off. A step that depends on one value must read
`PRAGMA foreign_keys` as the transaction's first statement and fail on any
other. SQLite cannot drop a column that carries a foreign key; rebuild the
table into a new name, copy the kept columns, drop the old table and rename.
Rebuilding a table that others reference also needs a parent-table rebuild
fixture.

**Before commit, two independent checks run:**

- **Integrity:** the runner runs `PRAGMA foreign_key_check` and aborts on any
  returned row.
- **Preservation:** each step's test against the frozen fixture. A clean
  integrity check cannot show that data survived.

Tests cover a failing step rolling back the earlier ones, a dangling
reference failing the integrity gate and the copy written before an upgrade.
Until the first step after the baseline exists these three have nothing to
run through; that step brings them back. Use parameter binding for row values.

Treat version zero deliberately: an empty database can be created, but an
unversioned populated database is not automatically a fresh installation.
Retain unsupported or corrupt data and surface the failure; reset or deletion
requires an explicit user action. Ordinary storage reads and writes start only
after successful initialization and migration.

Keep recovery of interrupted replies, `ChatRepository.initialize`, separate
from version conversion. Recovery must also work when the database is already
current. Persist durable user facts; keep active network requests, abort
controllers, callbacks and streaming workers out of stored contracts.
