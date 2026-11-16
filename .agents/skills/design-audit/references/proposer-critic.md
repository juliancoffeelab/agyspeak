# Proposer–critic review

The coordinator runs this optional procedure when paired review is requested or
delegation is authorized. Agreement between agents is not acceptance evidence.

## 1. Choose the mode and establish boundaries

- **Ordinary paired review:** run steps 2–3 and report the result.
- **Review with a withheld comparison:** establish the information boundary below
  before briefing participants, then run steps 2–5.

In either mode, specify scope, outputs, allowed source inspection/probes, file
ownership and a finite round limit. Default to at most five rounds, with early
convergence allowed. These are review stages; implementation requires a separate
request.

### Information boundary for a withheld comparison

Keep requirements public. Reserve historical findings or selected evaluation
cases/questions for after freeze; these cannot introduce new requirements.

A fresh conversation isolates history, not shared files or tool-accessible agent
messages. Use sanitized phase briefs and storage/context inaccessible to the
evaluated agents for genuinely withheld material. If access isolation is
unavailable, report the weaker boundary and limit independence claims accordingly.
Shared repository/scratch files are not private evaluator storage.

Participant briefs contain only their phase inputs; coordinator procedures and
specific withheld checks stay outside them. The coordinator monitors through
notifications/wait tools that do not expose unrelated agent summaries. If
information leaks, stop the affected comparison and assess exposure through
coordinator-accessible records. Asking whether a participant heard a particular
secret discloses it. When exposure is uncertain, restart the affected pair from
clean inputs and report the limitation; retain old work as historical material.

**Complete when:** review mode, scope, file ownership and stopping conditions are
specified; the withheld branch also has a declared information boundary and
sanitized initial briefs.

## 2. Produce independent initial work

Give fresh agents the same current requirements, constraints and source revision.
Use `fork_turns: "none"` where available; specify model/reasoning overrides only
when authorized. In design mode, the proposer drafts the design and workflow
traces. In audit mode, it explains and traces the reviewed plan, keeping proposed
revisions separate. The critic independently inspects the source for risks,
unjustified complexity and simpler alternatives. Withhold each agent's notes
from the other until both are complete.
In the withheld branch, both initially work without reserved historical material.

**Complete when:** both independent initial outputs exist and can be exchanged.

## 3. Run the dialogue

Participants communicate directly. The critic challenges missing trace steps,
unsupported assumptions, harmful coupling and future maintenance costs. Each
objection names a requirement or reachable sequence, its consequence and a
smaller alternative where available. The proposer records accepted/rejected
objections with reasons in each revision.

The coordinator monitors, intervenes for blockers/user steering and reports
material progress. At convergence or the round limit, save the design, decisions
and unresolved questions. For ordinary review, report the coordinator's
assessment and stop here.

**Complete when:** the critic explicitly records remaining substantive dissent or
conditional convergence, or the round limit is reached. Open conditions remain
visible; neither agreement nor exhaustion of rounds establishes quality.

## 4. Freeze for the withheld comparison

Both participants confirm the exact reviewed versions. Record hashes or a commit
identity and notify the coordinator before revealing reserved material.

**Complete when:** the compared artifacts are identifiable and immutable. Later
repairs belong to a new revision.

## 5. Compare independently, then report

Reveal the reserved historical findings/questions. Ask each participant for an
independent comparison before they exchange answers. Record covered risks,
omissions, contradicted assumptions, irrelevant old suggestions and implications
in a separate report. Historical mechanisms are alternatives; current requirements
control the assessment. Verify that the frozen artifacts stayed unchanged.

The coordinator assesses the comparison and the
[mechanism audit](design-review.md#5-audit-every-mechanism).
Report the frozen design, independent findings, unresolved decisions/evidence and
any contamination. A future implementor receives the agreed requirements and
selected design in a fresh context; withheld evaluation material stays outside
its access.

**Complete when:** the report distinguishes what the design independently covered
from what was discovered afterward, with the original artifacts preserved.
