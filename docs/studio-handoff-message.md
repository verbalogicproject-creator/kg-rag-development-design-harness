# Message for the L.S.Design session

Paste this. It answers the open question, gives the findings, and does not
require a reply — nothing on the harness side is blocked on it.

---

Decision on the mirror: **keep the separation.** No merge into the harness repo,
now or after the harness stabilises. Your subtree-split-and-merge plan for
`L.S.Design-studio` is the right call and needs no input from us — proceed
whenever it suits you, and the stale `v2` branch is yours to delete or keep.

The reasoning, briefly, because it is a real argument rather than deference:
an external consumer following your published docs literally found a bug an
internal one would have skipped, and an independent contrast implementation
cross-checked ours at 14/14 ratios. Both of those only exist because there are
two systems. Merging would hide the interface problems rather than fix them.

**Check this before the sync, because it changes what you are syncing.** The CLI
on PATH is `studio/dist/server/cli.js`, and it contains **zero** references to
the harness work that is committed in `studio/server/`:

```
$ grep -c harness studio/dist/server/cli.js
0
$ git log --oneline -1
674357b feat(studio): gate and router harness, plus the calibration log behind it
```

The dist is stale. Every consumer invoking the installed CLI — a skill, an MCP
entry, us for an entire session — is running the pre-harness build. Also worth
knowing: `studio/package.json` says `2.0.0` while the mirror says `2.1.0`, so
reconciling by version number reconciles backwards.

**One reproducible bug**, which made every screen in our review canvas render as
raw unstyled markup. `screen-authoring.md` requires a relative link to
`tokens.css`. Authored from `design/screens/board.html` that is `../tokens.css`,
which is correct on disk. `studio_add_screen` then stores the screen at
`design/screens/<slug>/rN/code.html` and serves it from `/files/`, rooted at the
design directory — so `../tokens.css` resolves to
`/files/screens/<slug>/tokens.css`, which does not exist. The link that works
from storage is `../../../tokens.css`, which no author would write and your docs
do not describe.

Fixes, ranked: rewrite the href on ingest (you know both the source and the
storage depth; nobody else does) · copy `tokens.css` into each revision
directory · document the depth, which is cheapest and worst because it exports
an implementation detail.

Related and cheap: unmatched paths return `200` with the SPA shell, so a missing
stylesheet reads as success and only the `content-type` gives it away. A `404`
for anything with a file extension would have made this self-diagnosing.

**Your validator was right and we were wrong.** It refused an attempt to inline
token values as a fallback — *"a token-driven screen must render from
`var(--ls-*)` and same-origin assets only"* — and that refusal stopped a bad
decision from shipping, because baking tokens removes the only property that
makes a screen token-driven. Keep it exactly as it is. It currently guards a
path that cannot succeed, which is the bug above, not a problem with the check.

**`HARNESS_CALIBRATION.md` is the interesting part.** CAL-01 and CAL-02 are the
same two failures we found from the consuming side, without having read that
file — a stale derived artifact after a hand-edited contract, and a passed gate
outliving the design that earned it. Ours became a lint rule comparing every
generated file against the hash `design.json` already records in `provenance`,
and content-addressed approvals superseded by any edit. Two parties reaching the
same two failures from opposite directions is the strongest evidence either of
us has that they are real.

One to add, if it earns a CAL entry: **`design.json` records provenance hashes
that nothing verifies.** The data was already being written; only the check was
missing. A hand-edit to `tokens.css` passed every check we had until we read it.

Full write-up, with reproductions and the things that worked well:
`docs/studio-feedback.md` in
github.com/verbalogicproject-creator/kg-rag-development-design-harness

Nothing here blocks us. Close out whenever you are ready.
