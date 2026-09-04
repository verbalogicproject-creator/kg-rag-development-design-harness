---
name: "Freelance Dashboard"
description: "A design contract created by ls-design-studio."
version: "1.0"
colors:
  background: "#F7F5F2"
  surface: "#FFFFFF"
  surface-raised: "#FBFAF8"
  content: "#1A1917"
  content-muted: "#5C574F"
  border: "#E2DED6"
  border-strong: "#948D82"
  primary: "#2F6F5E"
  on-primary: "#FFFFFF"
  accent: "#A0552A"
  on-accent: "#FFFFFF"
  success: "#2E7D52"
  warning: "#8A5D0F"
  danger: "#A33224"
  focus: "#2F6F5E"
  dark-background: "#151412"
  dark-surface: "#1F1E1B"
  dark-surface-raised: "#26241F"
  dark-content: "#F2EFE9"
  dark-content-muted: "#A8A296"
  dark-border: "#35332E"
  dark-border-strong: "#736E64"
  dark-primary: "#6FBFA5"
  dark-on-primary: "#10201B"
  dark-accent: "#E08E58"
  dark-on-accent: "#231409"
  dark-success: "#5FC48D"
  dark-warning: "#D9A441"
  dark-danger: "#E2705F"
  dark-focus: "#6FBFA5"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(2.5rem, 6vw, 4.5rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(1.875rem, 4vw, 2.75rem)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
  h3:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  body-small:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "0.25rem"
  md: "0.625rem"
  lg: "1.25rem"
  full: "9999px"
spacing:
  2xs: "0.25rem"
  xs: "0.5rem"
  sm: "1rem"
  md: "1.5rem"
  lg: "2.5rem"
  xl: "4rem"
  2xl: "6rem"
components:
  button:
    background: "{colors.primary}"
    color: "{colors.on-primary}"
    borderRadius: "{rounded.full}"
    paddingInline: "{spacing.md}"
    paddingBlock: "{spacing.xs}"
  card:
    background: "{colors.surface}"
    borderColor: "{colors.border}"
    borderRadius: "{rounded.lg}"
    padding: "{spacing.md}"
  input:
    background: "{colors.surface}"
    color: "{colors.content}"
    borderColor: "{colors.border}"
    borderRadius: "{rounded.md}"
---

# Freelance Dashboard

## Overview

**Premise.** State the premise in one sentence before the first build.

**Evidence.** Name the brand assets, content, or conversation this rests on.

**Direction.** Primary family: Choose one primary family.. Quiet counterpoint: Choose one quiet counterpoint.. Signature element: Name the one element this design will be remembered by..

**Excluded on purpose.** List the treatments this design deliberately rejects.

## Colors

Roles carry meaning, not appearance. `background` is the page ground; `surface` sits on it; `surface-raised` sits on `surface` and is the only third level. `content` and `content-muted` are the two text weights, and nothing between them is introduced later. `primary` marks the single most important action on a view; `accent` appears sparingly and never on a control. `success`, `warning`, and `danger` are reserved for state and never for decoration.

`border` and `border-strong` are two different jobs. `border` is a decorative hairline between two surfaces and is deliberately below 3:1 — a divider that meets 3:1 reads as a heavy rule and flattens the design. `border-strong` is the boundary of an interactive control, where WCAG 1.4.11 does apply, so it is contrast-verified at 3:1 and is what inputs, checkboxes, and outlined buttons use.

Dark values live in the same map under a `dark-` prefix. A role with no dark twin keeps its light value.

Verified pairs at authoring time:

| Foreground | Background | Target | Result |
|---|---|---|---|
| content | background | 4.5:1 | verify in the preview |
| content-muted | background | 4.5:1 | verify in the preview |
| content | surface | 4.5:1 | verify in the preview |
| on-primary | primary | 4.5:1 | verify in the preview |
| border-strong | surface | 3.0:1 | verify in the preview |

The preview recomputes every row in the browser, so a value that drifts is caught rather than trusted.

## Typography

Explain why this pairing fits the product.

Role to element: `display` for the one hero statement per page, `h1` through `h3` for document structure, `body` for prose at a measure of 60 to 72 characters, `body-small` for dense secondary text, `caption` for metadata, `label` for form and control labels, `mono` for code and precise numerics.

## Layout and Spacing

| Template | Purpose | Slots |
|---|---|---|
| Base | Root shell: lang and dir, skip link, semantic landmarks | head, header, main, footer |
| Marketing | Campaign and product pages | hero, sections[], cta, footer |

Add the layout templates this project actually needs.

Spacing is a named scale, applied as rhythm rather than as arbitrary numbers. Section separation uses `xl` and `2xl`; component internals use `xs` through `md`.

## Elevation and Depth

| Step | Meaning | Value |
|---|---|---|
| flat | Content on its own ground | none |
| raised | A card or panel lifted off the ground | 0 1px 2px rgb(0 0 0 / 0.06) |
| overlay | A menu, popover, or sheet above the page | 0 12px 24px -6px rgb(0 0 0 / 0.14) |

Shadow offsets are physical and do not flip with reading direction. These values are symmetric on the inline axis, so they stay correct in both directions.

## Shapes

`sm` for inputs and small chips, `md` for inputs and compact cards, `lg` for cards and media frames, `full` for pills and avatars. Name any signature shape treatment.

## Components

| Component | Purpose | Variants | States | Keyboard | Mirrors | Behavior | Without scripting |
|---|---|---|---|---|---|---|---|
| Button | Commit an action | primary, secondary, ghost | rest, hover, focus, active, disabled, loading | Enter and Space activate | No | Static | Fully usable |
| Theme toggle | Switch light and dark | — | rest, hover, focus, pressed | Enter and Space activate | No | Interactive on first interaction | Falls back to the system preference |

Add one row per meaningful component.

## Content schemas

| Type | Field | Required | Max length | Provenance |
|---|---|---|---|---|
| Feature | title | yes | 60 | Product copy |
| Feature | body | yes | 240 | Product copy |
| Specification | label | yes | 40 | Manufacturer data |
| Specification | value | yes | 40 | Manufacturer data |

Add one table per content type, with provenance.

A field with no real source is left out of the build. Quotations, statistics, awards, and customer names are never generated.

## States

Loading, empty, error, offline, long content, and text expansion under localization. Each interactive component defines all six or explicitly says which do not apply.

## Accessibility

Baseline WCAG 2.1 AA, target WCAG 2.2 AA including focus not obscured and a 24-pixel minimum target size. Visible focus on every interactive element. Reduced motion honored globally. Name the statement page and any additional requirement.

## Acceptance

- [ ] Zero horizontal overflow at 360, 768, and 1440 pixels
- [ ] Exactly one `h1` per page
- [ ] The skip link is the first tab stop
- [ ] Every contrast row passes at its stated target
- [ ] Zero physical directional CSS in new code without a justified `physical-ok` note
- [ ] Zero Unicode bidirectional control characters in source
- [ ] Reduced motion respected
- [ ] State the performance targets this project commits to.

## Do's and Don'ts

**Do**

- Keep the accent rare enough to still mean something.
- Let composition carry distinction before effects do.
- Recompose on small screens instead of shrinking.

**Don't**

- Do not introduce a colour outside the token map.
- Do not repeat one section shape across the whole page.
- Do not add motion that survives reduced-motion.
