# Notes for L.S.Design, from a full session consuming the studio

Written from building an eight-screen design contract through the studio end to
end — init, tokens, screens, approval, handoff — as the design plane of an
external harness. Everything below is something that cost time, with a
reproduction. Nothing is a style opinion.

---

## 1. The installed build is stale, and that is probably the first thing to check

```
$ readlink -f $(which ls-design-studio)
/root/frontend-skill/L.S.Design/studio/dist/server/cli.js

$ git -C /root/frontend-skill/L.S.Design log --oneline -1
674357b feat(studio): gate and router harness, plus the calibration log behind it

$ grep -c harness studio/dist/server/cli.js
0
```

The harness work is committed in `studio/server/` and absent from `studio/dist/`.
Anyone invoking the installed CLI — which is what a skill or an MCP entry does —
is running the pre-harness build. A whole session ran against it without
noticing, because nothing surfaces the mismatch.

Worth considering a `dist` freshness check, or building on publish.

## 2. The version numbers point the wrong way

`studio/package.json` in the monorepo says **2.0.0**; the standalone mirror is at
**2.1.0**. So the mirror reads as newer while the monorepo is ahead on content.
Anyone reconciling the two by version number will reconcile them backwards.

---

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
/files/screens/<slug>/tokens.css        → not found         ✗   ← what ../ resolves to
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

## 4. A missing file returns 200 and the SPA shell

Every unmatched path under `/design/` and `/files/` answers with `index.html` at
status 200. Diagnosing §3 took far longer than it should have because
`/design/tokens.css` returned **200** and looked like it was working; only the
`content-type` gave it away.

```
$ curl -s -o /dev/null -w '%{http_code} %{content_type}' /design/tokens.css
200 text/html; charset=utf-8      ← reads as success, is not
```

A 404 for asset-shaped requests (anything with a file extension) would make this
class of problem self-diagnosing.

---

## 5. Convergent findings — your calibration log and an external harness agree

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

## 6. What worked well, since a bug list is not a review

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
