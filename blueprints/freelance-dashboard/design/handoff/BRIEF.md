# Handoff brief — Freelance Dashboard

## 1. Premise

State the premise in one sentence before the first build.

## 2. Target stack

| Key | Value |
| --- | --- |
| framework | vite-react |
| styling | tailwind-v4 |
| typescript | true |
| tokensVia | css-vars |
| routerSkill | ls-design-websites |

## 3. Screens

| Slug | Title | Device | Size | Revision | Source |
| --- | --- | --- | --- | --- | --- |
| pipeline-board-populated | Pipeline board — populated | desktop | 1440x900 | 3 | agent |
| pipeline-board-empty | Pipeline board — empty | desktop | 1440x900 | 3 | agent |
| scout-inbox-populated | Scout inbox — populated | desktop | 1440x900 | 3 | agent |
| scout-inbox-empty | Scout inbox — empty | desktop | 1440x900 | 3 | agent |
| opportunity-detail-populated | Opportunity detail — populated | desktop | 1440x900 | 3 | agent |
| opportunity-detail-not-found | Opportunity detail — not found | desktop | 1440x900 | 3 | agent |
| profile-populated | Profile — populated | desktop | 1440x900 | 3 | agent |
| profile-empty | Profile — empty | desktop | 1440x900 | 3 | agent |

## 4. Token rules

**The contract is law.**

- Every colour, size, radius and font comes from the `--ls-*` custom properties or the framework theme.
- A needed value the contract lacks is a contract change, not a local literal.
- Component variants and states are the ones the contract lists.

## 5. Fixture quarantine

| Slug | Quarantined values |
| --- | --- |
| pipeline-board-populated | 4 |
| pipeline-board-empty | 0 |
| scout-inbox-populated | 3 |
| scout-inbox-empty | 0 |
| opportunity-detail-populated | 3 |
| opportunity-detail-not-found | 0 |
| profile-populated | 0 |
| profile-empty | 0 |

These are detected candidates, not a verdict. The detector cannot tell an invented number from a real one, so confirm each against the product facts in section 1: keep what the brief establishes, and replace what the generator made up. No unconfirmed value ships.

## 6. Offline note

Every approved screen is token-driven: `code.html` renders from the `tokens.css` and `fonts/` in this handoff and needs no network. The HTML is the record; `screen.png` is a capture of it under the tokens named in section 8.
The network was reachable at export time.

## 7. Build route

Read this brief first, then route the build through `ls-design-websites`.
Finish with a screenshot pass at 360/768/1440 and a closing `ls-design-review` pass.

## 8. Provenance

- DESIGN.md sha256: `49ecfa926b7b35046c26dc4de05730144f930011521a68fb5258f7e3cceffa1a`
- tokens.css sha256: `b747a60ca1d3851ffddec66f7894bac35ae2a8a3f9a7b26e09d2b7accf6dbfa0`
- preview.html sha256: `c3ae7cc939206c7e23d7837c31e319679b6b91f7b682736240586ee3325683b8`
- Tokens hash: `44c95ecdc528ed9990c3d52110ccb711924d3eafe21cd651efec4b018ab31bff`
- Revision: 38
- Exported at: 2026-09-05T09:35:32.071Z
