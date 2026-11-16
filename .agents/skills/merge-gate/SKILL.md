---
name: merge-gate
description: Use when the user asks to get a PR to merge gate, asks whether it is ready to merge, or asks to merge it.
---

# Merge gate

Audit existing evidence in under one minute, including tool calls and quick
checks. Preparation is separate work, undertaken only when requested. Routine
implementation, pushes and deployment do not invoke this skill.

## Prepare when requested

“Get it to merge gate” explicitly requests preparation: it authorizes one
fresh-context review subagent and requests history consolidation according to
the review's source-derived logical units. Follow
[working-with-subagents](../working-with-subagents/SKILL.md): validate before
review, resolve substantiated findings and complete necessary history cleanup
before auditing readiness. Reuse applicable existing review evidence; the
authorization does not require a redundant review or indiscriminate squashing.

## Audit the current head

Identify the PR head and inspect existing review/check results, the changed-file
list and commit history. Reuse evidence for unchanged content; assess whether
later changes invalidate its coverage. Check these five conditions:

- **Independent review:** cite a reviewer other than the implementer, reviewed
  revision/scope and the resolution or evidenced disposition of findings. The
  review must cover the final substantive change and explicitly assess
  requirements, scope and simplicity as required by [review](../review/SKILL.md).
  Agent reviewers use fresh context; human reviews also count.
- **Markdown hygiene:** name added, changed or deleted Markdown/guidance and cite
  its [writing-for-agents](../writing-for-agents/SKILL.md) review. Retained material
  serves a permanent purpose; temporary plans, handoffs and reports stay outside
  tracked content. Say “none” when no documents changed.
- **Lessons preserved:** check each material implementation/review lesson against
  the PR description: what was learned, why it matters and its effect on future
  work. Check description accuracy too. Summarize coverage with passage references
  and expand only gaps or disputed matches. If no material lesson emerged, give
  the reason. Include any lesson introduced by this verdict before grading.
- **History:** use the review's source-derived logical units and commit
  dispositions. Verify their mapping to the current patches, boundaries and
  messages. Each retained commit has a reason to stand alone; required cleanup
  is complete. A proposed squash merge is not completed cleanup.
- **Validation:** required checks passed for the current source. Cite commands,
  results and tested revision, distinguishing reused evidence from fresh checks.
  Reliable local results count without CI. Documentation-only changes need
  relevant checks.

Missing or stale requirements, scope, simplicity or history assessments remain
unverified; producing them belongs to review, not this audit. Bound quick probes
to the remaining time. Missing evidence or exhausted time is a gap, not an
instruction to launch reviews, install dependencies, run suites, fix files or
rewrite history. Quick probes do not replace required checks.

**Complete when:** each condition is supported, failed or unverified for the
identified head, or the time budget is reached.

## Return the verdict

Identify the head and report the five items once, each marked ✅ supported,
❌ failed or ❓ unverified with concise evidence. Reference existing assessments
rather than reproducing their reports. Report **ready** only when all five are ✅;
otherwise report **not ready** and the next action for each gap. Keep the verdict
in the response or PR metadata, without a tracked gate report file.

If preparation fixed bugs, list every bug fixed and the resulting behavior in
the final user message, including fixes made by subagents. A validation summary
or link to the review does not replace this list.

For an explicitly requested merge, follow repository permission and conflict
rules, confirm the head is unchanged and merge only the ready revision, using an
expected-head guard where supported. A moved head needs reassessment; a blocked
gate returns its verdict without starting preparation. Confirm a successful merge
with the hosting service.

**Complete when:** the user has the verdict, all checklist items and any
blockers; an authorized merge
is complete only after hosting-service confirmation.
