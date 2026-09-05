# AOSE Harness

An addon layer for Claude Code that turns app and website work into **checkable
artifacts**: a plan whose claims are verified by gates that actually run, a
design plane grounded in a knowledge graph rather than invented per session, and
cold dispatch that can send one frozen specification to several agents and
compare what comes back.

It does not write code better than Claude does. It makes what Claude produces
**consistent, cited, and provable** — across sessions, surfaces, and agents.

```bash
npm test                 # 171 harness tests, 38 example tests
npm run lint             # LINT-01..35 over a blueprint
npm run design:check     # the design gate: 8 checks, measured
npm run kg:ask -- directions cond_audience_solo_operator cond_content_tabular_numeric
```

---

## The idea in one line

> **Write down what must be true, and build the thing that checks it. Never one
> without the other.**

That sounds obvious. It isn't, because writing rules down is easy and checking
them gets skipped — and **a rule nobody checks looks exactly like a rule
somebody checks.**

This project found five of those in one session across three codebases. The
clearest: a design contract declared seven colour-contrast targets on the day
the project was initialised, and in all that time **not one had ever been
measured**. It read as a guarantee. It did nothing.

See [`docs/declarations-clarification-correction.md`](docs/declarations-clarification-correction.md)
for the full catalogue and the rule that follows.

## Four planes, one machine

Each plane runs the same five moves: declare the non-negotiables → lint the
declaration → a human gate that freezes what it approved → cold execution
against the frozen artifact → a scored review with cited evidence.

| Plane | Declares | Proves |
|---|---|---|
| **build** | `constitution.yaml`, specs, tasks | runs the execution gate, captures exit code and stdout hash |
| **look** | `design.system.yaml` | measures contrast, tokens, states, focus, motion, overflow |
| **ask** | a query pack's intent | traverses typed edges and cites every answer |
| **remember** | what the gates decided | replays it into the next run *(designed, not yet built)* |

## What is actually enforced

Nothing below is aspirational; each has a mechanism you can run.

- **35 lint rules** over the artifacts, including DAG acyclicity, EARS
  requirement shape, requirement↔scenario coverage, source allowlists with
  rationale, approval supersession, payload budgets, and token drift.
- **8 design gates** — contrast measured in both modes, every value on a
  declared scale, real empty states, focus indicators observed in a browser,
  reduced motion collapsed, palette coverage and hue budget, composite
  anti-patterns, horizontal overflow at every declared viewport.
- **A scored converge** across four pillars, five for a design-bound surface,
  where full credit requires measurement rather than the presence of artifacts.
- **A knowledge graph** of 69 curated design primitives over six closed
  relations, every node citing the file it was read from, that **refuses**
  rather than inventing when it has no support.

## The rules it will not break

Ten of them, one screen, each with the evidence that made it a rule:
[`docs/INVARIANTS.md`](docs/INVARIANTS.md). The two that catch the most:

> **A check that could not look reports `vacuous`, never `pass`.**
> Absence of evidence must not become evidence.

> **Approval is a human act.** Never recorded on a person's behalf. It is the
> one piece of evidence the design plane exists to produce.

## Layout

```
packages/aose/          the harness — schemas, lint, gates, dispatch, converge
packages/design-kg/     the design knowledge graph, curated and deterministic
blueprints/             worked blueprints, including a full freelance dashboard
docs/                   the vocabulary, the invariants, publishing, the method
```

## Documentation

| | |
|---|---|
| [GLOSSARY.md](docs/GLOSSARY.md) | the shared vocabulary — read first |
| [INVARIANTS.md](docs/INVARIANTS.md) | ten rules, with their evidence |
| [declarations-clarification-correction.md](docs/declarations-clarification-correction.md) | what a declaration is, and the failure mode |
| [PUBLISHING.md](docs/PUBLISHING.md) | npm and Apache 2.0, including what the licence does *not* protect |
| [codex-adversarial-review.md](docs/codex-adversarial-review.md) | using a different model family as an adversarial reviewer |

## Requirements

Node ≥ 24 (TypeScript runs directly via type stripping — no build step).
Dependencies: `zod` and `yaml`. Browser-backed design checks use a cached
Chromium if one is present and report `vacuous` if not.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Chosen for the express patent grant and its retaliation clause, which MIT does
not provide. [`docs/PUBLISHING.md`](docs/PUBLISHING.md) explains the reasoning
and is equally clear about what a permissive licence does not protect you from.
