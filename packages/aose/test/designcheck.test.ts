/**
 * The design gate.
 *
 * The rule these tests exist to defend: a check that inspected nothing reports
 * `vacuous`, never `pass`. This harness already caught one gate that exited 0
 * without running a single test because it inherited NODE_TEST_CONTEXT; the
 * design plane gets the same scepticism from the start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHex, luminance, contrastRatio, parseTokens,
  checkContrast, checkTokenResolution, checkPaletteCoverage, checkAntiDirection, hueOf, designCheck, loadDesignSystem, formatReport,
} from '../src/designcheck.ts';
import { DesignSystemSchema } from '../src/schema.ts';

/* ---- colour maths ---- */

test('contrast ratio matches the WCAG reference points', () => {
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  // Order must not matter: the ratio is defined on the lighter/darker pair.
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
  // #767676 on white is the canonical "just passes 4.5:1" grey.
  const grey = contrastRatio('#767676', '#FFFFFF')!;
  assert.ok(grey >= 4.5 && grey < 4.6, `expected ~4.54, got ${grey}`);
});

test('shorthand hex expands, and a non-colour is rejected rather than guessed', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#F7F5F2'), [247, 245, 242]);
  assert.equal(parseHex('var(--ls-color-content)'), null);
  assert.equal(parseHex('rebeccapurple'), null);
  assert.equal(contrastRatio('var(--x)', '#fff'), null, 'an unresolvable token must not score');
  assert.equal(luminance([0, 0, 0]), 0);
  assert.equal(luminance([255, 255, 255]), 1);
});

/* ---- token parsing ---- */

const CSS = `
:root {
  --ls-color-background: #FFFFFF;
  --ls-color-content: #111111;
  --ls-color-border-strong: #949494;
  /* --ls-color-ghost: #ABCDEF; */
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ls-color-background: #101010;
    --ls-color-content: #F0F0F0;
  }
}
:root[data-theme="dark"] {
  --ls-color-background: #101010;
  --ls-color-content: #F0F0F0;
}
`;

test('a token with no dark twin keeps its light value, as the contract says', () => {
  const tokens = parseTokens(CSS);
  assert.equal(tokens.light.get('ls-color-background'), '#FFFFFF');
  assert.equal(tokens.dark.get('ls-color-background'), '#101010');
  // border-strong is declared only once and must survive into dark.
  assert.equal(tokens.dark.get('ls-color-border-strong'), '#949494');
});

test('a commented-out token is not declared', () => {
  assert.equal(parseTokens(CSS).light.has('ls-color-ghost'), false);
});

/* ---- the checks ---- */

const system = (over: Record<string, unknown> = {}) => DesignSystemSchema.parse({
  design_system: {
    name: 'T', contract: 'design/DESIGN.md', tokens: 'design/tokens.css',
    tokens_hash: `sha256:${'a'.repeat(64)}`,
    direction: {
      family: 'precise-technical', thesis: 'T',
      anti_direction: [{ id: 'AD-01', rule: 'r', source: 's' }],
    },
    scales: {
      type: { steps: { body: '1rem' } },
      spacing: { base: '4px', steps: ['0.5rem', '1rem'] },
      radius: { steps: ['0.25rem'] },
      motion: { durations: { instant: '0ms', base: '200ms' } },
    },
    palette: { max_hues: 3, neutral_ramp: ['background', 'content'], modes: ['light', 'dark'] },
    accessibility: {
      contrast_pairs: [{ foreground: 'content', background: 'background', target: 4.5 }],
      modes_must_both_pass: true,
    },
    required_states: ['empty'],
    requirements: [{ id: 'DREQ-01', ears: 'WHEN it renders THE SYSTEM SHALL use tokens.', enforcement: 'gate', verified_by: ['DSC-01'] }],
    verification: {
      check_suite: 'c.ts', report: 'r.json',
      scenarios: [
        { id: 'DSC-01', given: 'g', when: 'w', then: 't', test_name: 'every visual value comes from a design token' },
        { id: 'DSC-02', given: 'g', when: 'w', then: 't', test_name: 'every declared contrast pair meets its target in both modes' },
      ],
    },
    ...over,
  },
}).design_system;

test('DSC-02 measures every pair in every mode and names the failing one', () => {
  // Light is fine; dark puts near-black text on a near-black ground. This is
  // the exact class of bug ART-10 exists for — a mode nobody ever measured.
  const failing = parseTokens(`
    :root { --ls-color-background: #FFFFFF; --ls-color-content: #111111; }
    :root[data-theme="dark"] {
      --ls-color-background: #101010;
      --ls-color-content: #3A3A3A;
    }
  `);
  const result = checkContrast(system(), failing);
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1, 'light passes, dark fails');
  assert.match(result.findings[0], /^dark: content on background = [\d.]+:1, needs 4.5:1/);
  assert.match(result.detail, /2\/2 pair-modes measured/);
});

test('DSC-02 is vacuous, never passing, when the tokens are missing entirely', () => {
  // The failure this guards against: an empty token set silently scoring a
  // clean sheet, which is how a design gate reports success having measured
  // nothing at all.
  const result = checkContrast(system(), { light: new Map(), dark: new Map() });
  assert.equal(result.status, 'vacuous');
  assert.notEqual(result.status, 'pass');
  assert.match(result.findings[0], /token not defined/);
});

test('DSC-02 reports an undefined token rather than skipping the pair', () => {
  const partial = parseTokens(':root { --ls-color-background: #FFFFFF; }');
  const result = checkContrast(system(), partial);
  assert.ok(result.findings.some((f) => /content.*token not defined/.test(f)));
});

test('DSC-01 is vacuous when no surface has been built yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-dc-'));
  const result = checkTokenResolution(system(), dir, ['src']);
  assert.equal(result.status, 'vacuous');
  assert.match(result.detail, /nothing to scan/);
});

test('DSC-01 catches a raw literal and lets an on-scale value through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-dc-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'Card.tsx'),
    'const a = { color: "#ff0000", padding: "1rem", gap: "13px", transition: "200ms" };');
  const result = checkTokenResolution(system(), dir, ['src']);
  assert.equal(result.status, 'fail');
  const joined = result.findings.join('\n');
  assert.match(joined, /colour literal "#ff0000"/);
  assert.match(joined, /length literal "13px"/);
  assert.equal(/"1rem"/.test(joined), false, '1rem is on the declared spacing scale');
  assert.equal(/"200ms"/.test(joined), false, '200ms is a declared duration');
});

/* ---- DSC-07: the contract and the tokens agree ---- */

test('DSC-07 catches a role the contract names and the tokens never define', () => {
  // The gap this closes: a contract could promise a role tokens.css does not
  // provide, and every other check would still pass.
  const tokens = parseTokens(':root { --ls-color-background: #FFFFFF; --ls-color-content: #111111; }');
  const sys = system({
    palette: { max_hues: 3, neutral_ramp: ['background', 'content'], semantic: ['primary'], modes: ['light'] },
  });
  const result = checkPaletteCoverage(sys, tokens);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /names role "primary" but tokens.css does not define it/);
});

test('DSC-07 counts hues against the declared budget and names them', () => {
  const tokens = parseTokens(`:root {
    --ls-color-background: #FFFFFF; --ls-color-content: #111111;
    --ls-color-primary: #2F6F5E; --ls-color-accent: #A0552A; --ls-color-danger: #A33224;
  }`);
  const sys = system({
    palette: {
      max_hues: 1, neutral_ramp: ['background', 'content'],
      semantic: ['primary', 'accent', 'danger'], modes: ['light'],
    },
  });
  const result = checkPaletteCoverage(sys, tokens);
  assert.equal(result.status, 'fail');
  assert.match(result.findings.at(-1)!, /distinct hues .* against a budget of 1/);
});

test('DSC-07 treats near hues as one, so a palette is not padded by shades', () => {
  // #A0552A and #A33224 are both clay-to-rust and sit within 30 degrees; a hue
  // budget counts colour families, not swatches.
  const tokens = parseTokens(`:root {
    --ls-color-background: #FFFFFF; --ls-color-content: #111111;
    --ls-color-accent: #A0552A; --ls-color-danger: #A33224;
  }`);
  const sys = system({
    palette: {
      max_hues: 1, neutral_ramp: ['background', 'content'],
      semantic: ['accent', 'danger'], modes: ['light'],
    },
  });
  assert.equal(checkPaletteCoverage(sys, tokens).status, 'pass');
});

test('hue maths places the shipped primary and accent where they belong', () => {
  assert.equal(hueOf('#2F6F5E')!.hue, 164, 'the primary is a green');
  assert.equal(hueOf('#A0552A')!.hue, 22, 'the accent is a clay orange');
  assert.equal(hueOf('#808080')!.saturation, 0, 'a true grey has no hue');
  assert.equal(hueOf('not-a-colour'), null);
});

test('DSC-07 says plainly that motion is contract-declared, not tokenised', () => {
  // design.md has no motion field, so durations cannot become custom
  // properties. Stating the limit beats a rule that could never pass.
  const report = designCheck('blueprints/freelance-dashboard');
  const coverage = report.checks.find((c) => c.id === 'DSC-07')!;
  assert.equal(coverage.status, 'pass');
  assert.match(coverage.detail, /motion is contract-declared, not tokenised/);
});

/* ---- the shipped blueprint ---- */

test('the dashboard passes contrast in both modes, and says so with numbers', () => {
  const report = designCheck('blueprints/freelance-dashboard');
  const contrast = report.checks.find((c) => c.id === 'DSC-02')!;

  assert.equal(contrast.status, 'pass');
  assert.equal(contrast.findings.length, 0);
  // Seven declared pairs across two modes. If either number drifts, the gate
  // stopped measuring something it claims to measure.
  assert.match(contrast.detail, /^14\/14 pair-modes measured/);
  assert.deepEqual(report.contrast_failures, []);
});

test('the dashboard screens are actually scanned, not merely counted as present', () => {
  // This test used to assert `vacuous`, which was correct while nothing was
  // built. Now the token-driven screens exist, so the stronger claim is that
  // the check really read them — a gate reporting `pass` over zero files is
  // the failure `vacuous` exists to prevent, and is covered on an empty
  // directory by its own test above.
  const report = designCheck('blueprints/freelance-dashboard');
  const resolution = report.checks.find((c) => c.id === 'DSC-01')!;

  assert.equal(resolution.status, 'pass');
  assert.match(resolution.detail, /^(?!0 )\d+ file\(s\) scanned/, 'it must have read at least one file');
  assert.deepEqual(report.unresolved_literals, []);
  assert.deepEqual(report.off_scale_values, []);
  assert.equal(report.ok, true);
});

test('every design scenario prints the test_name its contract declared (ART-04)', () => {
  const declared = loadDesignSystem('blueprints/freelance-dashboard')
    .verification.scenarios.filter((s) => s.id === 'DSC-01' || s.id === 'DSC-02');
  const report = designCheck('blueprints/freelance-dashboard');
  for (const scenario of declared) {
    const check = report.checks.find((c) => c.id === scenario.id);
    assert.ok(check, `${scenario.id} declared but not run`);
    assert.equal(check!.test_name, scenario.test_name);
  }
});

test('a contrast target the tokens only just clear is still reported as measured', () => {
  // border-strong on surface sits at 3.29 against a 3.0 target in the shipped
  // palette. A margin that thin is exactly why the number belongs in a report
  // rather than in someone's memory.
  const dir = 'blueprints/freelance-dashboard';
  const sys = loadDesignSystem(dir);
  const tokens = parseTokens(readFileSync(join(dir, sys.tokens), 'utf8'));
  const ratio = contrastRatio(
    tokens.light.get('ls-color-border-strong')!,
    tokens.light.get('ls-color-surface')!,
  )!;
  assert.ok(ratio >= 3.0, `border-strong must clear 3:1, measured ${ratio}`);
  assert.ok(ratio < 4.0, `and it is genuinely tight at ${ratio} — worth watching`);
});

test('a review-level scenario is surfaced, so the report never implies full coverage', () => {
  // DSC-06 scores anti_direction against a build. It is unfalsifiable by a
  // gate, so it is enforcement: review — but omitting it entirely would let a
  // reader believe six passing checks meant the contract was fully covered.
  // Invariant 1: a gap is labelled, never silent.
  const report = designCheck('blueprints/freelance-dashboard');
  const review = report.review_required.find((item) => item.id === 'DSC-06');

  assert.ok(review, 'DSC-06 is declared at review level and must appear');
  assert.equal(review!.requirement, 'DREQ-06');
  assert.equal(report.checks.some((c) => c.id === 'DSC-06'), false, 'it must not be scored as a gate check');
  assert.match(formatReport(report), /DSC-06[\s\S]*enforcement: review/);
});

/* ---- DSC-08: the composite, actually compared to the tokens ---- */

const compositeSystem = (over: Record<string, unknown> = {}) => system({
  direction: {
    family: 'precise-technical', thesis: 'T',
    anti_direction: [{
      id: 'AD-01', rule: 'the convergence composite', threshold: 3,
      source: 'natural-color-and-humanization.md',
      note: 'A brief naming any of these wins outright.',
      components: [
        { describes: 'A warm off-white ground', matches: ['#f7f5f1', '#F7F5F2'] },
        { describes: 'A default display serif', matches: ['Fraunces', 'Instrument Serif'] },
        { describes: 'A clay accent', matches: ['#d97757', '#A0552A'] },
        { describes: 'Warm near-black text', matches: ['#1a1714', '#1A1917'] },
      ],
    }],
  },
  ...over,
});

test('DSC-08 fires on the bundle that shipped in this project', () => {
  // AD-01 declared four members and a threshold of three, and nothing compared
  // it to the tokens. The list read as a guard and enforced nothing — the same
  // failure this project catalogues, committed in its own contract.
  const tokens = parseTokens(`:root {
    --ls-color-background: #F7F5F2;
    --ls-color-content: #1A1917;
    --ls-color-accent: #A0552A;
    --ls-font-display: Fraunces, Georgia, serif;
  }`);
  const result = checkAntiDirection(compositeSystem(), tokens);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /AD-01 fires at 4\/3/);
  assert.match(result.findings[0], /A brief naming any of these wins outright/,
    'the resolution travels with the failure — justify, do not redesign');
});

test('DSC-08 does not fire below the threshold', () => {
  // The source rule is explicit that any one of these is legitimate. A pairwise
  // model cannot express that; the threshold is the whole point.
  const tokens = parseTokens(`:root {
    --ls-color-background: #F7F5F2;
    --ls-font-display: Fraunces, Georgia, serif;
  }`);
  assert.equal(checkAntiDirection(compositeSystem(), tokens).status, 'pass');
});

test('DSC-08 reads a font stack member, not only an exact token value', () => {
  // "Fraunces, Georgia, serif" contains the flagged face. Matching the whole
  // declaration would miss every real font stack.
  const tokens = parseTokens(':root { --ls-font-display: Fraunces, Georgia, serif; }');
  const hit = checkAntiDirection(compositeSystem(), tokens);
  assert.match(hit.detail, /token value/);
  assert.equal(hit.status, 'pass', 'one member alone still does not fire');
});

test('DSC-08 is vacuous when no rule declares a threshold', () => {
  const noComposite = system({
    direction: {
      family: 'precise-technical', thesis: 'T',
      anti_direction: [{ id: 'AD-01', rule: 'no gradients', source: 's' }],
    },
  });
  const result = checkAntiDirection(noComposite, parseTokens(':root { --ls-color-background: #fff; }'));
  assert.equal(result.status, 'vacuous');
  assert.match(result.detail, /nothing composite was checked/);
});

test('the redesigned dashboard palette clears the composite', () => {
  const report = designCheck('blueprints/freelance-dashboard');
  const composite = report.checks.find((c) => c.id === 'DSC-08')!;
  assert.equal(composite.status, 'pass', composite.findings.join('\n'));
});
