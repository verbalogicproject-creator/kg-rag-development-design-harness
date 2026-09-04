# `/codex:adversarial-review`

A second opinion from a different model family, aimed at your architecture rather than your typos.

This note is written from one real use of it, on this repository, with the findings and outcomes
recorded below. It is meant to be portable: nothing here is specific to this project except the
evidence.

## The problem it solves

A model that plans a system, builds it, and then writes the tests for it shares one set of
assumptions across all three jobs. Its tests encode what it already believed. Its review notices
what it was already looking for. The failures it cannot see are exactly the ones its own framing
made invisible, and no amount of care inside that single frame reliably surfaces them.

This is not a hypothetical. In the run described below, the codebase had **87 passing tests** and
still contained a path traversal that would hand a worker another project's files, and an approval
gate bound to nothing at all. The green suite was not evidence of safety. It was evidence that the
author's own worries had been addressed.

A different model family has different priors, so it fails differently. That difference is the
entire value.

## What it actually is

A slash command from the OpenAI Codex plugin. It runs Codex over your repository in a
**read-only** sandbox and returns Codex's output verbatim. It does not edit anything, and the
command's own instructions forbid the invoking model from fixing what it reports.

```
/codex:adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text...]
```

Its prompt sets an explicitly hostile stance. The instructions tell Codex its job is to break
confidence in the change rather than validate it, to default to skepticism, and to give no credit
for good intent or likely follow-up work. It is pointed at expensive failure classes: trust
boundaries, data loss, rollback safety, partial failure, race conditions, version skew, and
observability gaps.

Two properties matter in practice:

- **It challenges design, not only defects.** The command description is "challenges the
  implementation approach and design choices". Ask it whether the approach is right and it will
  answer that question, not just hunt for bugs.
- **The model cannot invoke it.** The command sets `disable-model-invocation: true`, so Claude
  cannot run it on your behalf. You type it. That is deliberate, since it spends your Codex budget.

## What happened here

The target was an agent harness: about 2,900 lines, 87 tests, all passing, architecture settled,
nothing built on top of it yet. The review ran in the background and returned in roughly two
minutes.

Verdict: `needs-attention`. Six findings, four high and two medium. **All six held up under
inspection, and all six were fixed.**

| Severity | Finding | Why it mattered |
| --- | --- | --- |
| high | A design handoff path was joined to a root without a containment check | `../../other-project/handoff` would seed another project's approved files into a worker the system advertised as isolated |
| high | Approvals were bound to a timestamp, not to content | Editing a spec outside the tool left the approval standing, so work could dispatch under an approval that no longer described it |
| high | A scored quality gate consumed the latest lint result globally | Lint a compliant page once, then ship anything, and every surface collected the same points |
| high | A source allowlist checked declarations, not behavior | The system claimed a domain "may only reach" cleared hosts; nothing stopped a worker from fetching anything |
| medium | Citation checking compared titles and ignored the claim | A fabricated title scoring two thirds against a real one marked an unrelated claim "verified" |
| medium | A configured retry bound was never enforced | The blocked-to-retry cycle could repeat indefinitely despite a declared limit |

Every one of those is a place where the system's own claims about itself were stronger than its
mechanisms. That is the specific blind spot a single model is worst at seeing, because the claim
and the mechanism came from the same place.

Fixes took the suite from 87 tests to 98, including adversarial cases for traversal, post-approval
edits, cross-domain evidence reuse, and repeated retry cycles.

## How to get value from it

**Give it real focus text.** The generic run is fine. The useful run names the specific bets you
want attacked. In the run above the prompt listed seven numbered claims the architecture depended
on, phrased as challenges rather than descriptions:

> cold dispatch claims isolation, but the harness seeds upstream deliverables into the worktree,
> so check whether context leaks; approvals are superseded on any artifact edit, so look for a path
> that dispatches under a stale approval; the rubric scores from artifacts, so tell me how a worker
> could score 100 without doing the work

Every finding landed inside one of those seven. Writing the focus text is most of the work, and
writing it is itself useful: stating your load-bearing assumptions as attackable claims tends to
reveal one or two before the review even runs.

**Time it while findings are still cheap.** The best moment is after the architecture is settled
and before anything is built on top of it. Earlier and there is nothing concrete to attack. Later
and a structural finding means rework rather than an edit.

**Run it in the background.** For anything larger than a file or two, `--background` returns you to
work immediately and notifies you when it lands.

**Evaluate every finding yourself.** All six held here, but that is an outcome, not a guarantee.
The correct response to a finding is to reproduce it, not to accept it. Two of these were confirmed
by reading the exact lines it cited; one required checking that a function it called unenforced
genuinely had no caller.

## What it is not

- **It reviews a repository, not an abstract design document.** When the architecture is embodied
  in the code, that distinction barely matters. When your design lives only in a plan, it will have
  little to work with.
- **It does not fix anything.** Review only, by construction.
- **It is not a security audit or a substitute for your own tests.** It is one skeptical reader with
  different priors, which is a specific and limited thing to be.
- **Findings can be wrong or mis-scoped.** One of the six here was less a defect than an overclaim,
  and the right fix was to narrow what the system said about itself rather than to build the runtime
  enforcement the finding implied. That judgment is yours to make.

## The general principle

Separating the reviewer from the builder is an old idea, and putting a different model family in
the reviewer's seat is the cheap modern version of it. The same logic scales further: dispatch the
same specification to two or three different agents and compare what comes back. Agreement is
evidence. Disagreement is a specification that was not as clear as it looked.

An adversarial review is that idea applied one level earlier, to the design instead of the output,
where it costs a few minutes instead of a rebuild.
