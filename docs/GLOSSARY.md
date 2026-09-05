# Glossary

The shared vocabulary. Two people meaning different things by "gate" have no
shared model, so these are pinned here and every other document uses them
exactly this way.

Terms are grouped by what they are about, not alphabetised, because the
groupings are part of the meaning.

---

## The core pair

**Declaration** — a statement that must hold, paired with a mechanism that
proves it, at a named level of enforcement. The pair is the atomic unit; the
statement alone is not a weak declaration but not a declaration at all. See
[declarations-clarification-correction.md](declarations-clarification-correction.md).

**Mechanism** — the code that reads a declaration and decides whether it holds.
A named function, lint rule, or gate command. "The agent should follow it" is
not a mechanism.

**Enforcement level** — `lint`, `gate`, or `review`. Part of the declaration,
not a deployment detail.

**Freeze** — the act of writing a judgement into code so it stops being
re-decided. What converts a mental model into a contract, and the reason
"deterministic" here does not mean "no AI": the inference happened, once,
upstream, and was then pinned.

**Gap** — a declaration whose mechanism does not exist, *stated as such*. A
legitimate outcome. Silence is not.

---

## The three levels

**`lint`** — checked against the artifacts before anything runs. Cheap, total,
fails the blueprint. `LINT-01` through `LINT-35`.

**`gate`** — checked by running something and capturing the result. Produces
evidence: an exit code, a measured ratio, a captured hash.

**`review`** — checked by a person against a *named* list. Reserved for what is
genuinely unfalsifiable, and only useful when the list is citable.

---

## Planes

**Plane** — one application of the same five moves: declare non-negotiables →
lint the declaration → a human gate that freezes what it approved → cold
execution against the frozen artifact → a scored review with cited evidence.

**Build plane** — declares what the code must do (`constitution.yaml`, specs,
tasks), proves it by running the execution gate.

**Design plane** — declares what a surface must be (`design.system.yaml`),
proves it by measuring (`design-check`, DSC-01..07).

**Ask plane** — declares what question is being answered (a query pack), proves
it by traversing and citing.

**Remember plane** — records what the gates decided, so a later run starts warm.
Designed, not yet built.

---

## Build-plane artifacts

**Blueprint** — a directory holding one project's artifacts. Not the code; the
declarations the code is built against.

**Triad** — the three-level artifact shape: `system.manifest.yaml` →
`<domain>.spec.yaml` → `<domain>.task.yaml`. Manifest declares boundaries and
their dependency DAG; spec declares contracts and scenarios; task declares
deliverables and the execution gate.

**Constitution** — numbered articles (`ART-nn`) of non-negotiables, each with an
enforcement level. What every artifact in the project must satisfy.

**Domain** — one boundary in the manifest, e.g. `core/match`, `ui/client`. The
unit of dispatch.

**Contract** *(build plane)* — a named function signature with a precondition
and a postcondition. Distinct from the **design contract** below; when ambiguous,
say "spec contract" or "design contract".

**Scenario** — `SC-nn`, a given/when/then with a `test_name` the gate must find
in the output. The link that makes a requirement checkable.

**EARS** — the requirement grammar: `WHEN <trigger> THE SYSTEM SHALL <behavior>`.
Also `WHILE`, `IF`, `WHERE`. Enforced by `EARS_PATTERN`.

**Execution gate** — the command a task declares, plus the criteria its output
must satisfy. Run by the harness, never by the worker on its own word.

---

## Design-plane artifacts

**Design contract** — `design/DESIGN.md`. Tokens in frontmatter, intent in prose.
Portable: carries no suite-specific keys, so any tool reading the public
design.md format can consume it.

**Design system** — `design.system.yaml`. What `constitution.yaml` is to code:
direction, scales, palette budget, accessibility targets, `DREQ-nn` requirements
and `DSC-nn` scenarios.

**Direction family** — one of five canonical lenses: editorial restraint,
precise technical, tactile human, cinematic spatial, cultural expressive.
Chosen, never invented.

**Anti-direction** — `AD-nn`, a named thing the design must not be, each citing
its source. The falsifiable half of art direction. Some carry a `threshold`,
because the source rule is that any one value is fine and only the bundle is a
problem.

**Convergence bundle** — the specific composite generated design converges on:
warm off-white ground, high-contrast display serif, single clay accent. `AD-01`.

**Surface** — one screen-level region of a UI (`pipeline-board`, `profile`),
with a density and the states it must prove.

**Token** — a named semantic value (`--ls-color-content`), never a literal.
Roles survive a rebrand; `green` does not.

**Scale** — a closed set of legal values for one visual dimension. Membership is
what makes a value legal; a one-off is a defect even as a token.

**Handoff** — `design/handoff/`, the frozen approved snapshot. Released by the
studio only when every screen is approved. Built from, in preference to the live
folder.

---

## Execution

**Cold dispatch** — a fresh directory and a fresh process per attempt, seeded
only with declared inputs. The isolation claim, with `containedPath` as its
mechanism.

**Worker** — the agent process a task is dispatched to. `claude`, `codex`,
`agy`, `gemini`, or `fake` for offline runs.

**Adapter** — the per-CLI command builder and output parser. Named, swappable,
so one payload can reach any of them.

**Payload** — what a worker receives: articles, upstream exports, the spec, the
deliverables, the gate. Budgeted in tokens and lint-checked against that budget.

**Converge** — the scored review. Four pillars, five for a design-bound surface,
each ≥70 to pass. Components carry `earned`, `possible`, and a detail string.

**Respec** — returning a blocked project to `compile`, spending one of a bounded
allowance. Bounded because an unbounded retry loop is a livelock.

---

## Check outcomes

**`pass`** — the check looked and the declaration held.

**`fail`** — the check looked and it did not.

**`vacuous`** — the check could not look. Not a failure, and **never a pass**.
Earns no credit. A gate that passes by finding nothing has reported nothing.

**False-positive guard** — a test that must return empty. Every check needs one,
because a check that has never returned nothing has not been shown to be capable
of it.

---

## Graph and retrieval

**KG-RAG** — retrieval where the answer comes from traversing typed, directed
relationships rather than from similarity. Deterministic: same question, same
bytes.

**Domain pack** — the declaration binding one corpus: which adapter, which
columns mean what, which capabilities it serves, which relations exist and how
they are stored.

**Query pack** — the declaration of one intent: its flag, arguments, required
capabilities, ordering, limits. Knows nothing about tables or columns.

**Capability** — the runtime-checked protocol joining a query pack to a domain
pack. The query must declare it and the adapter must provide it; either alone
fails.

**Edge semantics** — how a domain stores a relation (`stored_as`) and which way
it points. Lets one intent run over corpora that store the same relation
differently.

**Refusal** — returning nothing, with a reason, instead of an invented answer.
The property that makes a graph safe to reason from.

**Provenance** — the source, record ids, and rationale carried by every returned
item. If you cannot cite, you do not include.

---

## Terms deliberately avoided

**"Best practice"** — names no mechanism and no source. Say which article, rule,
or check.

**"The system ensures"** — passive and unfalsifiable. Name the function.

**"Should"** — in a declaration, means nothing enforces it. Either a mechanism
exists, or write `gap:` and say so.
