# Repository instructions

Editing `AGENTS.md` requires explicit authorization from a human.

This repository contains two independent projects: the Python CLI in
`src/agyspeak/` (with its dependencies and vendored runtime) and the React Native
app in `reactnative/`. Keep their code, dependencies, configuration and
documentation self-contained; do not introduce cross-project imports or shared
code.

Keep always-applicable instructions in `AGENTS.md`. Put task-specific workflows
and their procedures in skills.

Do not modify `README.md` without an explicit user request.

For implementation details, speech markup, or vendored runtime maintenance,
read [DEVELOPMENT.md](DEVELOPMENT.md).

## Compatibility and input boundaries

Compatibility code is strictly forbidden unless explicitly requested by the
human. Validate the input format at the boundary and reject unsupported or
outdated formats rather than silently accepting, repairing or normalizing them.
Core code works only with current code and data contracts. A request to port,
refactor or match existing outputs does not authorize compatibility behavior.

## Conflicts

**Cornerstone rule: never resolve merge or rebase conflicts autonomously.**
Resolve conflicts only in response to an explicit user request for conflict
resolution. Do not initiate a merge, rebase, cherry-pick or branch synchronization
to address known conflicts without that explicit request. Requests to implement,
integrate, push, publish or prepare a PR do not imply permission to resolve
conflicts. If conflicts block requested work, report them and stop the affected
operation.

## Working files

Keep temporary data, experiments and diagnostics in the system temporary
directory (`$TMPDIR`, falling back to `/tmp`), outside the repository.
Tracked Markdown must contain permanent information; keep
current-work tracking and diagnostics out of tracked Markdown files.

## Interruptions

When the user interrupts ongoing work, stop that work and keep it paused. Address
only the interruption and explicitly requested follow-up. Resume the earlier
implementation, checks, commits or deployment only when the user asks to continue.

## Paid API requests

Before running scripts, tests, or benchmarks, check whether they make paid API
requests. Prefer offline checks when live inference is unnecessary. For paid
runs, state the planned request count and estimated cost, keep calls and retries
within the user's authorized scope and budget, and report actual cost when
available. Verify pricing rather than assuming a route is free.
