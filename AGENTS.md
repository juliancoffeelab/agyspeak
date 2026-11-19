# Repository instructions

## Projects and documentation

This repository contains two independent projects:
- the Python CLI in `src/agyspeak/` (with its dependencies and vendored
  runtime).
- the React Native app in `reactnative/`.

Keep their code, dependencies, configuration and documentation self-contained;
do not introduce cross-project imports or shared code.

Keep always-applicable instructions in `AGENTS.md`. Put task-specific workflows
and their procedures in skills.
Editing `AGENTS.md` requires explicit authorization from a human.

Do not modify `README.md` without an explicit user request. Flag it, if it
became outdated.

### Issues & PRs

If you post something from a user account, state very clearly that you are an
AI agent, and state the model and the harness at the beginning.

## UI & UX Principles

### Loading
- Startup should be fast and show as much of the final UI to the user as possible
as early as possible, by lazy-loading unnecessary parts.
When doing that, be mindful of keeping layout stable, avoid jumps and re-renders
if there is a reasonable alternative, such as putting the lazy-loading boundary
in the inner widgets.
- If placeholder UI is ever shown to a user it must have proper layout,
alignment and design as all other elements, and be a logical part of the visual
interface.
- Data should be prefetched when possible so the user never has to wait for
data loading.

### Errors
- Failures must have *a way to get* a full backtrace when desired and, if
reasonable, a way to retry cleanly.
When doing that, be mindful of whether it is possible to recover. Retry that
repeats the operation that failed again because of broken state is not helpful.
- Failures must be local if possible, failure inside one boundary shouldn't
affect other boundaries unless it is required for keeping the app in a reliable
state.
- Error UI must have proper layout, alignment and design as all other elements
and be a logical part of the visual interface.

### Flourishes
- The text in the UI is used for content. Prefer icons and/or colour-coding for
everything else, unless requested by a user.


## Workflow and development

### Compatibility and input boundaries
Compatibility code is strictly forbidden unless explicitly requested by the
human. Validate the input format at the boundary and reject unsupported or
outdated formats rather than silently accepting, repairing or normalizing them.
Core code works only with current code and data contracts. A request to port,
refactor or match existing outputs does not authorize compatibility behavior.

### Defaults and optionals
Avoid default arguments and pass things explicitly, unless there's a reasonable
need to tune the behavior as an override. Flag cases like this for a user.
Tests should not affect the shape of an API.

### Documentation and tooling
Keep temporary data, experiments and diagnostics in the system temporary
directory (`$TMPDIR`, falling back to `/tmp`), outside the repository.
Tracked Markdown must contain permanent information; keep
current-work tracking and diagnostics out of tracked Markdown files.

### Tests
Add permanent tests only when their expected value exceeds their total cost,
including runtime, maintenance, brittleness, and duplication. Prefer existing
checks or disposable probes when those sufficiently verify the change. Missing
tests alone do not justify adding them.

### Git conflicts
**Cornerstone rule: never resolve merge or rebase conflicts autonomously.**
Resolve conflicts only in response to an explicit user request for conflict
resolution. Do not initiate a merge, rebase, cherry-pick or branch synchronization
to address known conflicts without that explicit request. Requests to implement,
integrate, push, publish or prepare a PR do not imply permission to resolve
conflicts. If conflicts block requested work, report them and stop the affected
operation by explaining what exactly is conflicting and how would you resolve
it.

## Paid API requests

Before running scripts, tests, or benchmarks, check whether they make paid API
requests. Prefer offline checks when live inference is unnecessary. For paid
runs, state the planned request count and estimated cost, keep calls and retries
within the user's authorized scope and budget, and report actual cost when
available. Verify pricing rather than assuming a route is free.


## Interruptions

When the user send an interrupttion, stop that work and keep it paused. Address
only the interruption and explicitly requested follow-up. Resume the earlier
implementation, checks, commits or deployment only when the user asks to continue.
