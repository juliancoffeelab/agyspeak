---
name: review
description: Use when your task is to review a proposed or existing change.
---

# Review

Assess whether the change solves the intended problem and earns its place.
Review requests produce findings; editing the implementation is separate work.
For a merge-readiness decision, use [merge-gate](../merge-gate/SKILL.md).

## Establish scope

Read the user's requirements, applicable instructions and the complete change.
Identify the reviewed revision or working-tree state. Follow affected callers,
consumers and contracts far enough to understand the consequences.
Form your own conclusions before consulting earlier review conclusions. Distinguish
self-review from an independent review by someone who did not implement the change.

**Complete when:** the intended outcome and review scope are explicit, and each
changed area has been inspected in its relevant context.

## Apply four questions

- **Intent:** Does this solve the user's actual problem? Identify missed
  requirements, behavior that contradicts the request and unnecessary scope.
- **Correctness:** What concrete scenario breaks it? Trace boundary conditions,
  failures and interactions with existing behavior. Separate introduced defects
  from pre-existing problems.
- **Simplicity (KISS, YAGNI):** What is the smallest design that satisfies the
  current requirements? Compare the resulting design with a simpler alternative,
  including removing affected mechanisms, state, branches or configuration.
  Justify retained complexity by required behavior; reuse and DRY alone do not
  establish simplicity. Recommend removal when it reduces complexity while
  preserving required behavior; otherwise explain why the simpler alternative
  is insufficient.
- **Repository burden:** Does each added or retained file, dependency, rule and
  test in the affected design give more value than its total cost? Check for
  duplication, stale guidance and temporary requirements, plans or handoffs
  leaking into maintained content. For skills and
  agent instructions, apply the [instruction checklist](references/agent-instructions.md).

Resolve meaningful uncertainty by the cheapest useful method: source inspection,
an existing check, manual use or a disposable probe. Follow the affected project's
testing policy. Recommend a permanent test only if you can promise its value exceeds
its total burden, including runtime, maintenance, brittleness and duplication.
Missing permanent tests alone is not a finding. Ground findings in a concrete
consequence; label unresolved suspicions as questions rather than established bugs.

**Complete when:** all four questions have been applied across the change, and
suspected issues have either a supported consequence, a reason for dismissal or
an explicit unresolved question.

## Assess PR structure

For a PR, derive the logical changes and their dependencies from the requirements
and final diff **before consulting commit messages or history**. Use those units
to judge whether the final scope is necessary and the design is appropriately
small, then compare them with the actual commit patches and messages.

Give each retained commit a concrete reason to stand alone. Recommend folding,
splitting or removing commits where the patches do not fit the derived units;
corrections to an earlier change normally belong with that change. Record the
units and commit dispositions even when no cleanup is needed. For a working-tree
review without a proposed commit structure, leave history explicitly unassessed.

**Complete when:** final scope and simplicity are assessed against the request,
and every PR commit is accounted for against the source-derived units, or history
is explicitly unassessed.

## Report

Lead with actionable findings, ordered by impact. For each, give the location,
trigger or scenario, consequence and suggested direction. Include simplification
and burden findings when their benefit is concrete; skip personal style preferences.
Keep questions and verification limits distinct from findings. State when no
findings remain, and identify what was reviewed and any checks actually run.
For PRs, include the scope, simplicity and commit-structure assessment above so
the merge gate can check it against the current head.
Keep the review in the response or requested PR review, rather than adding a report
file to the repository.

End every review with **Intent, Correctness, Simplicity and Repository burden**,
each marked **✅ no issue found / ❌ finding / ❓ unresolved**. Give a concrete
reason and relevant scope limits for each; ✅ applies only to the reviewed scope.
For Simplicity, name the simpler alternative considered and why it was adopted
or why the retained complexity is necessary for the current requirements.

**Complete when:** the reader can act on each finding and understand the review's
scope and limits, and all four checklist results are reported.
