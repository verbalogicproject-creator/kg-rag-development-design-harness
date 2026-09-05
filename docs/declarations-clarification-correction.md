# Declarations: a clarification, and a correction

The word "declaration" has been doing too much work in this project, including
in my own writing. This document pins it down before more documents depend on
it, and corrects where it was used loosely.

Written from five real instances found in one session across three codebases.
Every claim here cites one.

---

## The correction

I have called all of these "declarations" without saying whether they are the
same kind of thing:

- an article in `constitution.yaml`
- a `contrast_pairs` entry in `design.system.yaml`
- `requires.capabilities` in a query pack manifest
- `edge_semantics` in a domain pack manifest
- `verified_by` on a requirement

**They are the same kind of thing, and the reason matters.** Each one names
something that must hold, and each one has a mechanism that proves it at a
declared moment. That is the whole definition. What varies is the artifact they
live in and the phase that checks them — not their nature.

Where I was loose: I used "declaration" for anything written in YAML. That is
wrong. A YAML field nothing reads is not a declaration. It is prose that
happens to have a colon in it.

---

## What a declaration is

> **A declaration is a statement that must hold, paired with a mechanism that
> proves it, at a named level of enforcement.**

The atomic unit is the **pair**, never the statement alone. A statement without
a mechanism is not a weak declaration — it is not a declaration at all.

```
  declaration            mechanism                     level
  ─────────────────────  ────────────────────────────  ──────
  ART-06 allowlist       LINT-30 + LINT-31             lint
  contrast_pairs         checkContrast, 14 ratios      gate
  verified_by: [SC-01]   the gate greps for test_name  gate
  anti_direction AD-01   threshold over components     review
  edge_semantics         adapter's _stored_edge_type   runtime
```

## What a declaration is not

**Not documentation.** Documentation describes what exists. A declaration is an
*input* to a program that checks it. If nothing reads it, it is documentation
wearing a schema.

**Not configuration.** Configuration tunes behaviour — change it and the system
does something different. Change a declaration and the system does the same
thing, but *judges* differently. `max_attempts: 2` is configuration.
`target: 4.5` is a declaration.

**Not an assertion of fact.** A declaration says what *must* be true, not what
*is* true. `tokens_hash` does not record what the tokens are; it says the
contract is only valid while they are that.

---

## The three roles, which get conflated

| Role | Who | When |
|---|---|---|
| **author** | a human, or a human with AI | at design time |
| **freeze** | code — a schema, a rule, a handler | once, deliberately |
| **check** | a machine, at a named phase | every run |

The middle one is the step people skip and the one that makes this work. AI can
help author a declaration. **The freeze is what converts a judgement into a
contract**: after it, the same input gives the same answer forever, and the
judgement stops being re-litigated every session.

This is also why "deterministic" here does not mean "no AI." The AI's judgement
is upstream and is then pinned. Nothing infers at check time.

---

## The three levels

Every declaration names how it is enforced. The level is part of the
declaration, not a deployment detail.

- **`lint`** — checked against the artifacts, before anything runs. Cheap,
  total, and it fails the blueprint.
- **`gate`** — checked by running something and capturing the result. Produces
  evidence: an exit code, a measured ratio, a captured hash.
- **`review`** — checked by a person, against a *named* list. Reserved for what
  is genuinely unfalsifiable.

The ladder exists because not everything is checkable and pretending otherwise
produces theatre. "Is this good design?" cannot be scored. "Does this exhibit
`AD-01`?" can, which is why `anti_direction` is `review` with citable entries
rather than `gate` with a number nobody believes.

---

## The failure mode

> **A declaration with no mechanism reads as a guarantee and behaves as
> nothing.**

It is worse than an absent rule, because the absent rule is visibly absent.
This one is invisible: the declaration is what people read, and it looks
identical to a declaration that is enforced.

### The catalogue

Five instances, one session, three codebases. This list is the reason the rest
of this document exists.

| # | Declaration | What it promised | What enforced it |
|---|---|---|---|
| 1 | `design.json.contrastPairs` | seven ratios, targets and all | nothing — declared the day the project was initialised, never measured until `checkContrast` was written |
| 2 | `declarum` `conflicts_with` edges | a design KG that knows what clashes | nothing — the edges exist in the data, the domain manifest never declared the semantic, so no query pack may traverse them |
| 3 | `query_packs/conflicts` `--right` | a comparison between two subsystems | nothing — `if (other === right_id \|\| true)` short-circuits the filter; invisible today at 0 rows, silently wrong the moment data lands |
| 4 | `design.system.yaml` motion scale | declared durations and easings | nothing used them; DSC-05 reported vacuous and said so |
| 5 | `master_kg_audit_log` | schema, CHECK constraint, five operation types, four migrations | **0 rows** — a whole feedback loop declared and never written to |

Note the shape. Every one is plausible. None is a mistake anybody would catch
by reading, because reading is exactly what they survive.

### The rule that follows

**Every declaration ships with its mechanism, or ships explicitly labelled as a
gap.**

Labelling is a legitimate outcome. `design.system.yaml` declares motion
durations that cannot become custom properties, because the public design.md
format has no motion field. That is stated in the check's own output —
*"motion is contract-declared, not tokenised"* — rather than left for someone
to discover. A known gap is a declaration about the limits of the mechanism,
which is still a pair.

---

## Corollaries

**A check that could not look reports `vacuous`, never `pass`.** Otherwise
absence of evidence becomes evidence, and every downstream score inherits it.
This is why both browser checks return `vacuous` with no browser, and why the
converge pillar pays a vacuous check nothing.

**Full credit requires measurement, not presence.** Design fidelity caps at 60
on studio artifacts alone; the remaining 40 needs the gate to have run. A pillar
that pays for artifacts rewards producing artifacts.

**A closed vocabulary is itself a declaration.** Six edge types, and a seventh
requires a schema change through lint and review. The alternative is measured:
76 edge types over 597 edges, 35 of them appearing exactly once, in a graph
where `enables` silently misses `enabled_by`.

**Negative constraints are checkable where positive ones are not.** This is not
a compromise, it is the only way the top of the ladder produces evidence. It is
the same move `detect_mud` makes: find the incompatibility rather than assert
the harmony.

---

## How to tell whether you have one

Three questions. All three must answer.

1. **What must be true?** If you cannot say it as a sentence that could be
   false, it is a preference, not a declaration.
2. **What reads it?** Name the function, the rule id, or the phase. "The agent
   should follow it" is not a mechanism — it is a hope with a schema.
3. **At what level, and what happens when it fails?** If the answer is "nothing
   happens", you have documentation. That may be fine. Do not call it a
   declaration.
