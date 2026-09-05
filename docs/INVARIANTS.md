# Invariants

Ten rules this harness does not break. One screen, so it can be handed to
anyone — a person, an agent, a reviewer deciding whether a new plane belongs.

Each is stated as a rule, then as the evidence that made it a rule. None is
aspirational; every one is enforced somewhere in the code today, or is named as
a known gap.

---

### 1. Every declaration ships with its mechanism, or is labelled a gap

A statement that must hold, with nothing that proves it, reads as a guarantee
and behaves as nothing. Labelling a gap is legitimate; leaving one silent is
not.

> `design.json` declared seven contrast targets on the day the project was
> initialised. Not one was measured until `checkContrast` existed. See
> [declarations-clarification-correction.md](declarations-clarification-correction.md)
> for the full catalogue of five.

### 2. A check that could not look reports `vacuous`, never `pass`

Absence of evidence must not become evidence. A gate that passes by finding
nothing has reported nothing, and every downstream score inherits the lie.

> Both browser checks return `vacuous` with no browser. The converge pillar pays
> a vacuous check zero. A gate once exited 0 without running a single test
> because it inherited `NODE_TEST_CONTEXT`; that is the failure this rule names.

### 3. Evidence is produced, never claimed

The harness runs the gate and captures the exit code, the stdout hash, and the
measured value. A worker saying it passed is not evidence.

> `runs` stores `gate_exit` and `gate_stdout_sha256`. Contrast is 14 measured
> ratios, not a note saying contrast was considered.

### 4. Approval is a human act

Never recorded on a person's behalf. The approval signature is the one piece of
evidence the studio exists to produce; forging it forges the thing being
measured.

> `ls-design-studio` states it directly: *"Never mark a screen approved on the
> person's behalf."* An agent may record a **rejection** — that is a check it
> ran — but never an approval.

### 5. Determinism is a contract, so artifacts carry no run state

No timestamps, elapsed times, random ids, or absolute paths in any artifact. Two
runs on the same inputs produce byte-identical output, which is what makes
golden comparison and drift detection possible at all.

> `tokens.report.json` embedded `/root/fable-blue/...` until it was caught before
> the first commit. It now carries the blueprint's name.

### 6. Zero model at gate time

Inference belongs upstream (authoring, extraction, scoring) or downstream
(summarising what was retrieved). Never inside a check. A gate that infers is
not reproducible and cannot be a contract.

> Every design check is CSS parsing, WCAG arithmetic, or a computed style read
> from a real engine. No model, no API call, no cost.

### 7. A worker sees only its declared inputs

Cold dispatch is a claim about isolation, so the mechanism must enforce it: a
fresh directory, seeded from upstream deliverables and the frozen handoff, and
nothing else.

> Every blueprint-declared path is resolved through `containedPath`. Absolute
> paths, `..` traversal, and symlinks pointing away are rejected — a design
> handoff of `../../other-project/handoff` was a real finding.

### 8. Negative constraints where positive ones cannot be checked

"Is this good?" cannot be scored and scoring it produces noise. "Does this
exhibit this named thing?" can. This is not a compromise; it is the only way the
`review` level yields evidence.

> `anti_direction` has eight entries, each citing its source. ART-11: a review
> that cannot name the item it judged against has reviewed nothing.

### 9. Vocabularies are closed, and opening one is a schema change

A new node type, edge type, or lint rule goes through the schema, the linter,
and review. Vocabularies that grow one session at a time decay into synonyms.

> Measured, in a graph that had no such rule: 76 edge types over 597 edges, 35
> appearing exactly once, with `enables` / `enabled_by` / `enables_methodology`
> all distinct. A traversal for "what enables X" silently misses two thirds.

### 10. Full credit requires measurement, not presence

A score that pays for artifacts existing rewards producing artifacts. Points
come from what was measured.

> Design fidelity caps at 60 on studio artifacts alone. The remaining 40 requires
> the gate to have run — closing the "score 100 without doing the work" hole the
> adversarial review named.

---

## Using these

**To judge a new plane:** it belongs if it can satisfy 1 through 6. If its
claims cannot be mechanised, it is guidance, not a plane — which is a fine thing
to be, and should be called that.

**To judge a new check:** it must be able to fail, and it must be able to report
`vacuous`. A check with no failing case and no empty case is not a check.

**To judge a new declaration:** answer the three questions at the end of
[declarations-clarification-correction.md](declarations-clarification-correction.md).
