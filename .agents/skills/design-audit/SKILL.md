---
name: design-audit
description: An opt-in workflow for requirements, design, and plan audits.
disable-model-invocation: true
---

# Design audit

Turn requirements into a small, justified design. Evaluate mechanisms as well as
promised outcomes. Planning, review and implementation are separate authorizations;
completing a planning stage is a handoff, not permission to implement.

## Choose the requested scope

- **Requirements:** establish the inventory below and stop there.
- **Design:** reuse agreed inputs, complete missing requirements below, then follow
  [design review](references/design-review.md).
- **Existing-plan audit:** read the plan and supplements, validate their inputs
  against the requirements below, then follow
  [design review](references/design-review.md). Keep proposed revisions separate;
  edit the plan only when requested.

Reuse existing requirements and acceptance criteria; identify request-relevant
gaps instead of restarting settled work. For requested or authorized paired
review, read [proposer–critic](references/proposer-critic.md) before briefing
participants. Otherwise work without the pair.

## 1. Establish the requirements

Read existing instructions, requirements and decisions before proposing changes.
Separate:

- **Values:** priorities used to choose among otherwise valid solutions.
- **Functional requirements:** actions and observable behavior the system supports.
- **Non-functional requirements:** qualities such as responsiveness, readiness,
  reliability, continuity and resource bounds.
- **Architectural constraints:** required ownership, technologies and boundaries.

Use the user's values. Unless they specify others, assess interaction latency,
simplicity, maintainability, and performance/scalability. Maintainability includes
both preventing mistakes and keeping ordinary changes local and understandable.

Clarify terms with concrete examples. Record approved requirements separately
from proposals and open decisions. Preserve existing behavior unless a change is
authorized; distinguish inherited defects from behavior worth preserving.

**Complete when:** every stated requirement has a category, scope and observable
meaning; unresolved choices and conflicts are explicit.
