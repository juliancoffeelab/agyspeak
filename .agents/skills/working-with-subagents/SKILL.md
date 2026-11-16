---
name: working-with-subagents
description: Use when handling a user request for subagents or coordinating authorized subagents.
---

# Working with subagents

## User authorization

Use subagents only when the user explicitly requests them. Each request authorizes
at most one subagent for that task, including any nested delegation.

Use multiple subagents only when the user explicitly requests multiple subagents
for that specific task. That authorization ends with the task and does not carry
over to later tasks. Each later task requires its own explicit user request and
returns to the one-subagent limit unless the user explicitly requests multiple
again.

## Roles and order

- **Worker:** implements a bounded task so work can proceed in parallel. Give it
  a clear scope, ownership boundaries and an expected result.
- **Reviewer:** provides an independent view to find what the implementer missed.
  Give it the requirements, source and `review`, with
  fresh context rather than the implementer's reasoning or earlier conclusions.

**Review goes at the end.** The implementer owns verification and validation to
the best of its ability before involving a reviewer. This applies equally to the
main agent and worker subagents. Review is not a substitute for the implementer's
own checks. After integrating parallel work, validate the combined change before
requesting its review. Fix substantiated findings and validate the fixes before
requesting any necessary follow-up review.

## Execution models

**Active is the default**, including for reviewers. Monitor progress and use the
available wait tool until the subagent completes. Handle blockers and inspect its
result; keep the user informed during longer waits. Finish the active work before
returning a final response, unless the user interrupts or changes the task.

**Background is only for a user request:** the user asks for a background agent
or explicitly wants the main agent available for other work while delegation
continues. For example, a worker can build a focused benchmark while the main
thread discusses the broader design.

For background work, returning to the user promptly is the immediate priority.
Prefer a small, focused assignment. Supply enough context, decision authority,
validation expectations and completion criteria for the agent to work independently
with greater autonomy, within existing permissions. Launch it, briefly tell the
user what is running, and return without waiting for completion. On completion,
surface the result and any blockers when available; distinguish a launched task
from a completed one.

**Complete when:** active results have been inspected and incorporated into the
task outcome, or authorized background work is launched with a self-contained
assignment and the main thread is available to the user.
