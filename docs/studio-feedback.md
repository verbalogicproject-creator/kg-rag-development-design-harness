# Notes for L.S.Design, from a full session consuming the studio

Written from building an eight-screen design contract through the studio end to
end — init, tokens, screens, approval, handoff — as the design plane of an
external harness.

**Revised after L.S.Design checked the claims.** Two of the five did not hold
and are withdrawn below with the counter-evidence. They failed the same way:
a command was run as though it were a check, without asking what a passing or
failing result would actually mean. A grep for a string in one file is not a
test of whether a build is current, and probing `/design/` says nothing about
`/files/`. Verifying before acting was the right call and it cost me two
findings.

The remaining three hold, and §3 is the one that matters.

---

## 1. WITHDRAWN — "the installed build is stale"

**This claim was wrong.** It rested on a test that did not test what I thought
it tested, and the L.S.Design side was right to check it rather than act on it.

I ran `grep -c harness studio/dist/server/cli.js`, got `0`, and concluded the
build predated the harness work. But:

```
grep -c harness server/cli.ts    → 0     ← the SOURCE has none either
grep -c harness dist/…/cli.js    → 0
ls dist/server/harness/          → route.js, run.js   present and current
find server shared -name '*.ts' -newer dist/server/cli.js  → nothing
```

`build:server` is `tsc -p` — per-file emit, not a bundle — so the harness lands
in its own files. My grep measured whether one entry file *imports* the harness,
which it does not and need not. **The CLI on PATH is current. Nothing to
re-sync.**

## 2. WITHDRAWN — "a missing file returns 200 and the SPA shell"

**Also wrong, and I had the disconfirming evidence in my own output.**

`/files/*` mounts before the catch-all and returns a proper 404:

```
404 text/plain    /files/screens/<slug>/tokens.css
404 text/plain    /files/nope.css
200 text/html     /design/tokens.css      ← not the asset route
200 text/html     /design/nope.css
```

I probed `/design/*` paths, saw the SPA shell, and generalised to "unmatched
paths". `/design/` is not where assets are served. Worse: I *did* probe
`/files/.../tokens.css`, recorded `not found` in the body, and never checked the
status code — so I wrote a claim that my own transcript contradicted.

The fix I suggested — 404 for anything with a file extension — is the existing
behaviour under `/files/`. There is nothing to do here.

## 2b. The version note, corrected

Both `package.json` files say **2.0.0**, the mirror's included, because it came
from the same bytes. What says **2.1.0** is the suite `VERSION` and the release
commit. So there is nothing to reconcile *between* the repos.

The real inconsistency is narrower and still worth fixing: `studio/package.json`
was not bumped when v2.1.0 shipped studio changes.

I verified the monorepo's version and then restated the mirror's from prose as
though it were a checked fact. It was not.

## 3. The bug: a stored screen cannot resolve the link the docs require

**This one is real and reproducible**, and it made every screen in the review
canvas render as raw unstyled markup.

`references/screen-authoring.md` says:

> Link `design/tokens.css` with a relative `<link>` in the document head. Do not
> inline a copy of the tokens.

Followed literally from where a screen is authored — `design/screens/board.html`
— that is `../tokens.css`. Correct on disk.

`studio_add_screen` then stores it at:

```
design/screens/<slug>/r1/code.html
```

and the canvas serves it from `/files/screens/<slug>/r1/code.html`, with `/files/`
rooted at the design directory. From there, `../tokens.css` resolves to
`/files/screens/<slug>/tokens.css`, which does not exist.

```
/files/tokens.css                       → 200 text/css      ✓
/files/screens/<slug>/tokens.css        → 404 text/plain    ✗   ← what ../ resolves to
/files/screens/<slug>/r1/code.html      → 200 text/html     ✓
```

The link that works from storage is `../../../tokens.css`, which is not what an
author would ever write and not what the docs describe.

**The screen is valid, the docs are followed, and the render is still wrong.**
The workaround here was a build step rewriting the depth before ingest, which
works but means the file the studio stores is not the file the author wrote.

Three ways out, in rough order of preference:

1. **Rewrite the href on ingest.** The studio knows both the source and the
   storage depth; nothing else does.
2. **Copy `tokens.css` into each revision directory.** Costs a few KB per
   revision and makes the stored screen self-sufficient.
3. **Document the storage depth** and have authors write `../../../tokens.css`.
   Cheapest, and the worst of the three — it exports an implementation detail.

### The validator is right, and worth keeping

An earlier attempt inlined the token values as a fallback. The studio refused:

> `a token-driven screen must render from var(--ls-*) and same-origin assets
> only: hex-color-literal "#F4F6F8" (line 19) …`

That refusal was correct and saved a bad decision from shipping — baking tokens
into a screen removes the only property that makes it token-driven. Good check.
It just currently guards a path that cannot succeed.

---

## 4. Convergent findings — your calibration log and an external harness agree

`docs/HARNESS_CALIBRATION.md` records:

| ID | Finding |
|---|---|
| CAL-01 | Stale derived artifact after a hand-edited contract |
| CAL-02 | A passed gate outlived the design that earned it |

Both were found independently from the consuming side, without having read that
file:

- **CAL-01** became a lint rule comparing every generated file against the hash
  `design.json` already records in `provenance` — data the studio was writing
  and nothing was reading. A hand-edit to `tokens.css` previously passed every
  check.
- **CAL-02** became content-addressed approval: an approval is bound to a digest
  over the contract and the frozen handoff, and is superseded by any edit.

Two parties reaching the same two failures from opposite directions is the
strongest evidence either has that they are real rather than theoretical.

One addition from this side, which may be worth a CAL entry: **`design.json`
records file hashes in `provenance` that nothing verifies.** The data is already
there; only the check is missing.

---

## 5. What worked well, since a bug list is not a review

- **`studio_get_tokens` computing contrast independently** was the single most
  valuable thing encountered. It cross-checked an external WCAG implementation
  at 14 of 14 ratios to two decimal places — that implementation had unit tests
  against reference points but had never been checked against another engine.
- **The gate refusing to export while screens are pending**, and stamping a
  forced export as provisional, is exactly the right shape. A handoff that
  cannot lie about its own approval is what makes the rest of a pipeline
  trustworthy.
- **`tokenDriven` and `staleTokens` as first-class state.** Marking screens
  stale on a token edit, and exempting token-driven ones, is a distinction most
  tools do not make.
- **The MCP surface is well-shaped.** `open_project → status → add_screen →
  wait_for_decision → export_handoff` needed no guessing beyond §3.
