/**
 * The design gate — the design plane's execution_gate.
 *
 * Every other plane of this harness produces evidence by running something.
 * The design plane only ever checked that files existed, which is how
 * `design.json` could declare seven contrast targets on the day a project was
 * initialised and never have one of them measured. This module measures them.
 *
 * Deterministic, dependency-free, and it costs nothing to run: parsing CSS and
 * computing WCAG luminance needs no model. The one genuinely unfalsifiable
 * check (DSC-06, scoring a build against its anti_direction) is deliberately
 * not here — it is `enforcement: review`, not `gate`.
 *
 * A check with nothing to inspect reports `vacuous`, never `pass`. A gate that
 * passes by finding nothing has reported nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';
import { DesignSystemSchema } from './schema.ts';
import type { DesignSystem } from './schema.ts';

export type CheckStatus = 'pass' | 'fail' | 'vacuous';

export interface CheckResult {
  id: string;
  test_name: string;
  status: CheckStatus;
  detail: string;
  findings: string[];
}

export interface DesignReport {
  blueprint: string;
  tokens_hash: string;
  ok: boolean;
  checks: CheckResult[];
  /* Scenarios the contract declares at `review` level. They are not gate checks
     and score nothing, but a report that omitted them would let a reader believe
     the gate covers everything the contract asks for. Invariant 1: a gap is
     labelled, never silent. */
  review_required: { id: string; test_name: string; requirement: string }[];
  contrast_failures: string[];
  off_scale_values: string[];
  unresolved_literals: string[];
}

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

/** #rgb, #rrggbb, or #rrggbbaa. Alpha is ignored: a token used as a ground is opaque. */
export function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance. */
export function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21, rounded to two places the way a report reads it. */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = parseHex(foreground);
  const b = parseHex(background);
  if (!a || !b) return null;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export interface TokenSets { light: Map<string, string>; dark: Map<string, string> }

/**
 * Read `--ls-*` custom properties for both modes.
 *
 * Light is the bare `:root`. Dark is light overlaid with whatever a
 * `[data-theme="dark"]` or `prefers-color-scheme: dark` block redefines, which
 * is the same cascade a browser applies — a token with no dark twin keeps its
 * light value, exactly as the contract says.
 */
export function parseTokens(css: string): TokenSets {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();

  const declarations = (block: string): [string, string][] =>
    [...block.matchAll(/--(ls-[a-z0-9-]+)\s*:\s*([^;]+);/gi)]
      .map((m) => [m[1], m[2].trim()] as [string, string]);

  // Strip comments so a commented-out token cannot masquerade as declared.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

  /* Cut out each dark block by matching braces, not by assuming the closing
     one sits at column 0. An indented block — a rule nested inside a media
     query, or any formatter's output — would otherwise be left in place and
     its dark values would overwrite the light set. */
  const darkBlocks: string[] = [];
  let lightSource = '';
  const openers = /(?:@media[^{]*prefers-color-scheme:\s*dark[^{]*|:root\[data-theme="dark"\][^{]*)\{/g;
  let cursor = 0;
  for (let match = openers.exec(source); match; match = openers.exec(source)) {
    if (match.index < cursor) continue;
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    lightSource += source.slice(cursor, match.index);
    darkBlocks.push(source.slice(match.index, index));
    cursor = index;
    openers.lastIndex = index;
  }
  lightSource += source.slice(cursor);

  for (const [name, value] of declarations(lightSource)) light.set(name, value);
  for (const [name, value] of light) dark.set(name, value);
  for (const block of darkBlocks) for (const [name, value] of declarations(block)) dark.set(name, value);

  return { light, dark };
}

/** Resolve a semantic role ("content") to its literal in one mode. */
function colourFor(tokens: Map<string, string>, role: string): string | undefined {
  return tokens.get(`ls-color-${role}`);
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

/**
 * DSC-02 — every declared contrast pair, in every declared mode.
 *
 * This is the check the whole artifact was built to make possible. The targets
 * have been sitting in design.json since the project was initialised.
 */
export function checkContrast(system: DesignSystem['design_system'], tokens: TokenSets): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-02');
  const modes: ('light' | 'dark')[] = system.accessibility.modes_must_both_pass
    ? (system.palette.modes as ('light' | 'dark')[])
    : ['light'];
  const findings: string[] = [];
  let measured = 0;

  for (const mode of modes) {
    const set = tokens[mode];
    for (const pair of system.accessibility.contrast_pairs) {
      const fg = colourFor(set, pair.foreground);
      const bg = colourFor(set, pair.background);
      if (!fg || !bg) {
        findings.push(`${mode}: ${pair.foreground} on ${pair.background} — token not defined (${!fg ? pair.foreground : pair.background})`);
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      if (ratio === null) {
        findings.push(`${mode}: ${pair.foreground} on ${pair.background} — not a hex colour (${fg} / ${bg})`);
        continue;
      }
      measured += 1;
      if (ratio < pair.target) {
        findings.push(`${mode}: ${pair.foreground} on ${pair.background} = ${ratio}:1, needs ${pair.target}:1 (${fg} on ${bg})`);
      }
    }
  }

  const total = system.accessibility.contrast_pairs.length * modes.length;
  return {
    id: 'DSC-02',
    test_name: scenario?.test_name ?? 'every declared contrast pair meets its target in both modes',
    status: measured === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: `${measured}/${total} pair-modes measured across ${modes.join(' and ')}`,
    findings,
  };
}

/** Hue in degrees, and how saturated it is. A near-grey has no hue worth counting. */
export function hueOf(hex: string): { hue: number; saturation: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  return { hue: hue < 0 ? hue + 360 : hue, saturation };
}

/**
 * DSC-07 — the contract and the token file agree.
 *
 * The gap this exists for: `design.system.yaml` can name a colour role, or a
 * whole scale, that `tokens.css` never defines. Nothing caught that before, so
 * a contract could promise more than the tokens could deliver and every other
 * check would still pass. It also counts hues against `palette.max_hues`,
 * because a budget nobody counts is not a budget.
 *
 * Motion is deliberately exempt: the public design.md format has no motion
 * field, so durations live in the contract and are checked against it rather
 * than resolved through a custom property. That is a real limit of the format,
 * and stating it here is better than a rule that would always fail.
 */
export function checkPaletteCoverage(
  system: DesignSystem['design_system'],
  tokens: TokenSets,
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-07');
  const findings: string[] = [];
  const roles = [...new Set([
    ...system.palette.neutral_ramp,
    ...system.palette.semantic,
    ...system.accessibility.contrast_pairs.flatMap((p) => [p.foreground, p.background]),
  ])];

  const modes: ('light' | 'dark')[] = system.palette.modes as ('light' | 'dark')[];
  for (const role of roles) {
    for (const mode of modes) {
      if (!colourFor(tokens[mode], role)) {
        findings.push(`${mode}: the contract names role "${role}" but tokens.css does not define it`);
      }
    }
  }

  // Hue budget, counted over the semantic roles in the light set. Greys are not
  // hues; anything below a modest saturation floor is part of the neutral ramp.
  const hues: number[] = [];
  for (const role of system.palette.semantic) {
    const value = colourFor(tokens.light, role);
    const parsed = value ? hueOf(value) : null;
    if (!parsed || parsed.saturation < 0.15) continue;
    if (!hues.some((h) => Math.min(Math.abs(h - parsed.hue), 360 - Math.abs(h - parsed.hue)) < 30)) {
      hues.push(parsed.hue);
    }
  }
  if (hues.length > system.palette.max_hues) {
    findings.push(`palette carries ${hues.length} distinct hues (${hues.sort((a, b) => a - b).join('°, ')}°) against a budget of ${system.palette.max_hues}`);
  }

  const tokenised = Object.values(system.scales.motion.durations)
    .filter((d) => [...tokens.light.values()].includes(d)).length;

  return {
    id: 'DSC-07',
    test_name: scenario?.test_name ?? 'the token file provides every role the contract declares',
    status: roles.length === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: `${roles.length} role(s) checked across ${modes.join(' and ')}, ${hues.length}/${system.palette.max_hues} hue(s) used`
      + (tokenised === 0 ? '; motion is contract-declared, not tokenised (design.md has no motion field)' : ''),
    findings,
  };
}

const LITERAL_PATTERNS: [string, RegExp][] = [
  ['colour', /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\boklch\([^)]*\)/gi],
  ['length', /(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b/gi],
  ['duration', /(?<![\w-])\d+(?:\.\d+)?m?s\b/gi],
];

/** Files a surface actually produced, if any exist yet. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?|css)$/.test(entry.name)) out.push(path);
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out;
}

/**
 * DSC-01 — every visual value resolves to a declared token (ART-07), and every
 * resolved value sits on a declared scale (ART-09).
 *
 * The generated token file is the definition of the scales, so it is exempt;
 * what this scans is the code a worker wrote.
 */
export function checkTokenResolution(
  system: DesignSystem['design_system'],
  dir: string,
  searchRoots: string[],
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-01');
  const files = searchRoots.flatMap((root) => sourceFiles(join(dir, root)));
  const findings: string[] = [];

  const allowed = new Set<string>([
    ...system.scales.spacing.steps,
    ...system.scales.radius.steps,
    ...Object.values(system.scales.type.steps),
    ...Object.values(system.scales.motion.durations),
    ...(system.scales.border?.steps ?? []),
    ...(system.scales.tracking?.steps ?? []),
    '0', '0px', '100%',
  ]);

  for (const file of files) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const relative = file.slice(dir.length + 1);
    for (const [kind, pattern] of LITERAL_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const value = match[0];
        if (kind !== 'colour' && allowed.has(value)) continue;
        findings.push(`${relative}: ${kind} literal "${value}" does not resolve to a token`);
      }
    }
  }

  return {
    id: 'DSC-01',
    test_name: scenario?.test_name ?? 'every visual value comes from a design token',
    // Nothing built yet is not a pass. Saying so is the whole point of this harness.
    status: files.length === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: files.length === 0
      ? 'no surface source exists yet — nothing to scan'
      : `${files.length} file(s) scanned`,
    findings: findings.slice(0, 40),
  };
}

/** A surface as the spec declares it, once compile has normalised bare strings. */
export interface SurfaceDecl { id: string; density?: string; states?: string[] }

/** `<surface>.html` is the populated state; `<surface>-<state>.html` is any other. */
export function screenFor(dir: string, surface: string, state: string): string | null {
  const name = state === 'populated' ? `${surface}.html` : `${surface}-${state}.html`;
  const path = join(dir, 'design', 'screens', name);
  return existsSync(path) ? path : null;
}

/**
 * DSC-03 — a surface with no data renders a real empty state.
 *
 * DREQ-03 is gate-level, so this fails rather than warns when a surface that
 * declares `empty` has no empty screen: the requirement cannot be demonstrated,
 * and a requirement nobody can demonstrate is not satisfied. It also reads the
 * screens it does find, because a file named `-empty` proves nothing on its own
 * — the rule is that it names a next action and ships no placeholder rows.
 */
export function checkStates(
  system: DesignSystem['design_system'],
  dir: string,
  surfaces: SurfaceDecl[],
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-03');
  const findings: string[] = [];
  let covered = 0;
  let declared = 0;

  for (const surface of surfaces) {
    for (const state of surface.states ?? system.required_states) {
      declared += 1;
      const path = screenFor(dir, surface.id, state);
      if (path) covered += 1;
      else if (state === 'empty') {
        findings.push(`${surface.id}: declares the empty state but no screen proves it (expected design/screens/${surface.id}-empty.html)`);
      }
    }

    const emptyPath = screenFor(dir, surface.id, 'empty');
    if (!emptyPath) continue;
    const html = readFileSync(emptyPath, 'utf8');

    // A next action must exist and be reachable, not merely described.
    if (!/<(?:button|textarea|input|select)\b/i.test(html)) {
      findings.push(`${surface.id}: the empty state describes no reachable action — REQ-04 asks it to name the next action, not narrate the absence`);
    }
    // Placeholder rows are the failure ART-08 names: plausible-looking invention.
    const rows = (html.match(/class="(?:card|row-item)\b/g) ?? []).length;
    if (rows > 0) {
      findings.push(`${surface.id}: the empty state ships ${rows} placeholder row(s); an empty surface renders no rows at all`);
    }
  }

  return {
    id: 'DSC-03',
    test_name: scenario?.test_name ?? 'every surface renders a real empty state',
    status: surfaces.length === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: `${covered}/${declared} surface-states have a screen; ${surfaces.length} surface(s) declare an empty state`,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

export function loadDesignSystem(dir: string, path = 'design.system.yaml'): DesignSystem['design_system'] {
  const raw = YAML.parse(readFileSync(join(dir, path), 'utf8'));
  return DesignSystemSchema.parse(raw).design_system;
}

/**
 * Run the design gate over a blueprint.
 *
 * `searchRoots` are the places a built surface would live. An empty result is
 * reported as vacuous rather than passing, so an unbuilt surface can never
 * bank evidence it did not earn.
 */
export function designCheck(
  dir: string,
  surfaces: SurfaceDecl[] = [],
  /* The studio's token-driven screens are real code and are checked as such,
     alongside wherever a built surface lands. Checking the reference screens is
     what keeps DSC-01 from being vacuous until the app exists. */
  searchRoots: string[] = ['design/screens', 'src', 'app', 'ui'],
): DesignReport {
  const system = loadDesignSystem(dir);
  const tokensPath = join(dir, system.tokens);
  const tokens = existsSync(tokensPath)
    ? parseTokens(readFileSync(tokensPath, 'utf8'))
    : { light: new Map<string, string>(), dark: new Map<string, string>() };

  const checks = [
    checkTokenResolution(system, dir, searchRoots),
    checkContrast(system, tokens),
    checkPaletteCoverage(system, tokens),
    checkStates(system, dir, surfaces),
  ];

  const contrast = checks.find((c) => c.id === 'DSC-02')!;
  const resolution = checks.find((c) => c.id === 'DSC-01')!;

  const gateIds = new Set(checks.map((check) => check.id));
  const reviewRequired = system.requirements
    .filter((requirement) => requirement.enforcement === 'review')
    .flatMap((requirement) => requirement.verified_by
      .filter((id) => !gateIds.has(id))
      .map((id) => ({
        id,
        test_name: system.verification.scenarios.find((s) => s.id === id)?.test_name ?? id,
        requirement: requirement.id,
      })));

  return {
    review_required: reviewRequired,
    /* The blueprint's own name, never the absolute path it happened to be run
       from. A report that embeds a device path is not reproducible, and this
       one is meant to be compared across machines and across runs. */
    blueprint: basename(dir),
    tokens_hash: system.tokens_hash,
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    contrast_failures: contrast.status === 'fail' ? contrast.findings : [],
    off_scale_values: resolution.findings.filter((f) => !f.includes('colour literal')),
    unresolved_literals: resolution.findings.filter((f) => f.includes('colour literal')),
  };
}

/** Human-readable gate output. Every scenario prints its `test_name` (ART-04). */
export function formatReport(report: DesignReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok' : check.status === 'vacuous' ? '--' : 'FAIL';
    lines.push(`${mark.padEnd(4)} ${check.id}  ${check.test_name}`);
    lines.push(`       ${check.detail}`);
    for (const finding of check.findings) lines.push(`       · ${finding}`);
  }
  for (const item of report.review_required) {
    lines.push(`--   ${item.id}  ${item.test_name}`);
    lines.push(`       ${item.requirement} is enforcement: review — a person judges this, no gate can`);
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const vacuous = report.checks.filter((c) => c.status === 'vacuous').length;
  lines.push('');
  lines.push(failed
    ? `FAIL — ${failed} check(s) failed${vacuous ? `, ${vacuous} had nothing to inspect` : ''}`
    : `PASS — ${report.checks.length - vacuous} check(s) passed${vacuous ? `, ${vacuous} had nothing to inspect` : ''}`);
  return lines.join('\n');
}
