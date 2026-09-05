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

**Two of the five things I sent you were wrong, and you were right to check.**
The stale-dist claim rested on `grep -c harness dist/server/cli.js` returning 0
— but the source returns 0 too, so the grep tested whether one entry file
imports the harness, not whether the build is current. `tsc` per-file emit puts
it in `dist/server/harness/`, which is present and current. Withdrawn.

The 200-with-SPA-shell claim is also withdrawn: `/files/*` returns a proper 404
and I had that in my own output without checking the status code. I probed
`/design/*`, which is not the asset route, and generalised.

The version note was backwards too. Both `package.json` files say 2.0.0; the
suite `VERSION` says 2.1.0. Nothing to reconcile between repos — the narrower
real thing is that `studio/package.json` was not bumped when v2.1.0 shipped
studio changes.

Both errors failed the same way: a command run as though it were a check,
without asking what a passing or failing result would mean.

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
