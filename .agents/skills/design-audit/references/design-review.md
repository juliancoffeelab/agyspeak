# Design and existing-plan review

Read for a design or existing-plan audit after establishing the relevant
requirements in [SKILL.md](../SKILL.md). Reuse agreed requirements and acceptance
criteria; complete only the missing stages. For an audit, evaluate the existing
plan and supplements and keep proposed revisions separate from the reviewed
version. Edit it only when requested.

## 2. Ground the design in the source

Inspect the relevant entry points, owners, data flow, resources and lifetimes.
Distinguish source facts, reproduced behavior, inferences and proposed changes.
Separate reusable resource preparation from computing runtime state and normal
execution. Establish the actual cost or missing readiness before adding eager
preparation, pools or rejection paths.

For a design request, draft the proposed owners, boundaries, data flow and
mechanisms from these facts and requirements. Keep alternatives and unresolved
choices explicit. For an audit, use the existing plan as the proposal under review.

**Complete when:** source facts establish the relevant ownership, data flow and
lifetimes; the proposed design is identifiable, and its assumptions and
unverified failure hypotheses are labeled.

## 3. Propose acceptance criteria and verification

For each requirement, state the pass condition, supported scope, evidence and
failure consequence. Keep budgets proposed until agreed; choose them before
using measurements to claim acceptance. Select behavioral checks, source review
and measurements appropriate to each requirement. Inspect generated artifacts
when the design depends on compiler or bundler behavior.

Plan the smallest feasibility check for consequential API/platform assumptions;
run it only within the authorized scope. Match measurements to the promised
outcome: processing or submission is not necessarily user-visible completion.
For UI work, distinguish publication, rendering, presentation and physical
output. Record unsupported environments. Implementation measurements and final
validation belong to the later implementation stage.

**Complete when:** each in-scope requirement has a verification route; unknowns have
the smallest useful check and a decision that its result would inform. Missing
evidence stays unverified. An unknown blocks its dependent work, not every task.

## 4. Walk concrete workflows

Inventory primary workflows from the functional requirements and existing entry
points. Mark each traced, missing, or excluded with a scope reason. Trace ordinary
actions first; then choose interruption cases from their actual boundaries.
Follow:

`trigger -> entry point -> authoritative operation/data -> consumer -> resource
use -> observable result`

Name existing functions/components and label proposed ones. Record ownership,
preparation time, asynchronous boundaries, cancellation, cleanup and recovery.
For UI work, distinguish displayed and current state and explain exactly what
the user sees: content, pending state, failure or an unchanged view. Verify
existing entry points in source; explicitly design and mark proposed ones.

Exercise relevant interruptions such as newer state during loading, replacement
before completion, or failure and retry. Identify steps depending on unstated
assumptions; a desired outcome is not a trace.

**Complete when:** every primary workflow is accounted for, included workflows
have an unbroken route or an exact missing step, and interruption choices have
reasons. Missing steps block readiness of the dependent design; record them as
findings when the request is review only.

## 5. Audit every mechanism

Inventory substantive mechanisms across the plan and supplements. For each,
identify its requirement or reachable failure/cost, current handling, simpler
alternative, and added implementation/maintenance cost. An accepted requirement
or source-supported failure can justify a protection without a reproduced
production incident. Split rows when a justified principle has an overbroad
implementation. Rate each against the values and a fifth check:

> Does this solve a demonstrated, reachable problem with proportionate complexity?

Use this table, adapting value columns to the user's priorities:

| Mechanism | Latency | Simplicity | Maintainability | Performance / scalability | Justification | Evidence and disposition |
| --------- | ------- | ---------- | --------------- | ------------------------- | ------------- | ------------------------ |

- **Good:** justified benefit or necessary, proportionate protection.
- **Irrelevant:** no material effect on this dimension; not a synonym for unknown.
- **Bad:** avoidable cost, harmful coupling, overbroad protection or speculative
  machinery adopted without sufficient justification.

Evaluate what is written, not its most charitable possible implementation.
Include startup, memory, cancellation and future feature costs. Label estimates
and uncertainty; these grades are design judgments, not measured results.
Benefit claims and criticism both need support. A mixed or costly necessary
mechanism can still be justified. Hard constraints remain mandatory regardless
of grades; do not select a design by counting Good cells.

Apply the same scrutiny to the review checklist: questions should uncover
evidence, not silently mandate a new framework or universal guarantee.

**Complete when:** every substantive mechanism is accounted for, each Bad grade
has a reason, and proposed retention/removal/simplification is explicit. Keep
unanswered evidence questions distinct from proven defects.

## 6. Close the design review

Report justified mechanisms, proposed removals/simplifications, remaining
decisions, evidence limits and readiness for the next stage. When revision is
requested, make the changes and repeat affected workflow traces. Preserve the
reviewed version so changes remain distinguishable.

**Complete when:** the user can distinguish agreed requirements, selected design,
open choices and unverified predictions. Implementation readiness means the
dependent design questions are resolved or have explicitly bounded feasibility
work; it does not imply that performance, reliability or compatibility is proven.
