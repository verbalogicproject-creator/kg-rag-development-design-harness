/**
 * The design checks that need a browser.
 *
 * Focus indicators and reduced-motion behaviour are computed-style facts: no
 * amount of reading CSS tells you whether an element actually shows a focus
 * ring, because the answer depends on the cascade, the selector matching, and
 * the user-agent stylesheet. So these two run in a real engine.
 *
 * They live apart from designcheck.ts deliberately. That module is pure — it
 * parses text and does arithmetic, so it is trivially testable and runs
 * anywhere. This one spawns a process, and when no browser is present it
 * reports `vacuous` rather than `pass`: a check that could not look has not
 * looked, and saying so is the whole discipline.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CheckResult, SurfaceDecl } from './designcheck.ts';
import { screenFor, parseTokens } from './designcheck.ts';
import type { DesignSystem } from './schema.ts';

/** Where a cached Chromium usually lands. Absent is a normal state, not an error. */
export function findBrowser(): string | null {
  if (process.env.AOSE_CHROMIUM && existsSync(process.env.AOSE_CHROMIUM)) return process.env.AOSE_CHROMIUM;
  const root = join(process.env.HOME ?? '/root', '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  const builds = readdirSync(root)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const binary of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
      const path = join(root, build, binary);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * Run a probe script inside a screen and read the result back.
 *
 * The script writes JSON into document.title and we take it from the dumped
 * DOM: no CDP client, no dependency, and the same technique works on any
 * Chromium build. The probe file is a copy, so the screen under test is never
 * modified by the act of testing it.
 */
/**
 * Inline a screen's own stylesheets into the copy under test.
 *
 * The probe copy is rendered from `file://`, and a `file://` stylesheet fetch
 * can fail under I/O pressure. When it did, the page rendered unstyled and
 * DSC-04 reported a focus defect on every interactive element of that screen —
 * a red suite caused by this machine's disk, not by the design. Inlining
 * removes the second fetch entirely, so the failure mode stops existing rather
 * than being reported politely.
 *
 * Deliberately conservative. A sheet is inlined only when it is a relative
 * path that resolves to a real file and contains neither `url()` nor `@import`,
 * because both resolve against the stylesheet's own location and would change
 * meaning once moved into the document. Anything else keeps its `<link>` and is
 * fetched as before — and if that fetch fails, `guarded` still catches it.
 */
export function inlineStylesheets(html: string, screenDir: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || /^data:/i.test(href)) return tag;

    const path = resolve(screenDir, href);
    if (!existsSync(path)) return tag;
    let css: string;
    try { css = readFileSync(path, 'utf8'); } catch { return tag; }
    // Relative references inside the sheet would resolve against the document
    // once inlined, which is a different file. Leave those alone.
    if (/url\(|@import/i.test(css)) return tag;
    // `</style>` inside the CSS would close the block early. It cannot appear
    // in valid CSS, but the copy must not be corruptible by the file it reads.
    if (/<\/style/i.test(css)) return tag;
    return `<style data-aose-inlined="${href}">\n${css}\n</style>`;
  });
}

let probeSeq = 0;

export function probe(
  browser: string,
  screenPath: string,
  script: string,
  flags: string[] = [],
): unknown {
  /* Unique per call. The name used to be derived from the screen alone, so two
     probes of one screen — concurrent `aose design-check` runs, or a suite
     spawning several — wrote and unlinked the same file, and one of them lost
     its copy out from under Chromium. That surfaced as `null`, i.e. a screen
     reported unmeasurable for a reason that had nothing to do with the screen. */
  const probePath = screenPath.replace(/\.html$/, `.aose-probe-${process.pid}-${probeSeq++}.html`);
  const html = inlineStylesheets(readFileSync(screenPath, 'utf8'), dirname(screenPath))
    .replace('</body>', `<script>${script}</script></body>`);
  writeFileSync(probePath, html);
  try {
    const dom = execFileSync(browser, [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      // Absolute, always: a relative path makes the first segment a hostname
      // and the browser silently loads nothing.
      ...flags, '--dump-dom', `file://${resolve(probePath)}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    const title = /<title>([\s\S]*?)<\/title>/.exec(dom)?.[1] ?? '';
    const decoded = title.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return decoded ? JSON.parse(decoded) : null;
    /* Callers must not cast this. A probe can return a value that parses but is
       not the shape expected — a page whose own <title> happens to be valid
       JSON, or a script that did not run and left the original title in place.
       `probeStyledArray` below is the checked way to read one. */
  } catch { return null; }
  finally { try { unlinkSync(probePath); } catch { /* best effort */ } }
}

/* ------------------------------------------------------------------ */
/* Making sure the page under test is the page that was authored.      */
/* ------------------------------------------------------------------ */

/**
 * Token names the screens are entitled to see, read from the contract's own
 * tokens.css rather than hardcoded, so the guard cannot drift from the system
 * it guards.
 */
export function guardTokens(dir: string, limit = 3): string[] {
  const path = join(dir, 'design', 'tokens.css');
  if (!existsSync(path)) return [];
  return [...parseTokens(readFileSync(path, 'utf8')).light.keys()].slice(0, limit);
}

/**
 * Wrap a probe so it refuses to report on an unstyled page.
 *
 * A `file://` stylesheet can fail to load under I/O pressure. When it does, the
 * DOM is complete and correct and every computed style is wrong — and because
 * `outline: 2px solid var(--ls-color-focus)` is invalid at computed-value time
 * once the token is missing, the focus ring does not merely change colour, it
 * disappears. The check then reports a real-looking design defect on every
 * interactive element of the screen. That was measured, not theorised: with
 * tokens.css absent, profile-empty.html reports all 8 of its elements
 * unfocusable while `:focus-visible` still matches.
 *
 * `document.styleSheets.length` does not catch it — a link that failed to load
 * is still counted. The resolved value of a declared token does.
 */
function guarded(script: string, tokens: string[]): string {
  return `(function(){
  const names = ${JSON.stringify(tokens)};
  if (names.length) {
    const cs = getComputedStyle(document.documentElement);
    if (!names.some((n) => cs.getPropertyValue('--' + n).trim())) {
      document.title = JSON.stringify({ aose_unmeasurable: 'design tokens did not resolve; the stylesheet did not load' });
      return;
    }
  }
${script}
})();`;
}

export interface StyledProbe {
  /** The parsed value, when the page was styled and the script returned one. */
  value: unknown | null;
  /** Set when the page loaded unstyled, so nothing about it can be concluded. */
  unmeasurable: string | null;
}

/**
 * Probe a screen that must be styled for the answer to mean anything.
 *
 * Retries once. A stylesheet that failed to load is a fact about this machine's
 * I/O at this moment, not about the design, and a check that flips between
 * pass and fail run to run teaches people to re-run rather than to look. A
 * second consecutive failure is reported rather than retried away.
 */
export function probeStyled(
  browser: string,
  screen: string,
  script: string,
  tokens: string[],
  flags: string[] = [],
): StyledProbe {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = probe(browser, screen, guarded(script, tokens), flags);
    const blocked = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { aose_unmeasurable?: string }).aose_unmeasurable
      : undefined;
    if (!blocked) return { value: raw, unmeasurable: null };
    if (attempt === 1) return { value: null, unmeasurable: blocked };
  }
  /* Unreachable: the loop returns on both attempts. Present so the function has
     one exit type rather than an implicit undefined. */
  return { value: null, unmeasurable: 'probe did not run' };
}

/**
 * The same, for probes whose result must be an array.
 *
 * Casting `probe()`'s return to an array was a real crash: when the injected
 * script did not set the title as expected, `for (const x of result)` threw
 * `result is not iterable` and took the whole design gate down instead of
 * reporting that one screen could not be measured. A cast is a claim; this is
 * the check.
 */
export function probeStyledArray(
  browser: string,
  screen: string,
  script: string,
  tokens: string[],
  flags: string[] = [],
): { rows: unknown[] | null; unmeasurable: string | null } {
  const result = probeStyled(browser, screen, script, tokens, flags);
  return { rows: Array.isArray(result.value) ? result.value : null, unmeasurable: result.unmeasurable };
}

/**
 * How an incomplete measurement is reported.
 *
 * Three outcomes, in this order, and the order is the point:
 *
 * - A real finding wins. An incomplete sweep must never mask a defect that was
 *   actually observed on a screen that did load.
 * - Otherwise, a screen that could not be measured makes the whole check
 *   `vacuous`. "Every element I could see was fine" is not "every element is
 *   fine", and reporting a pass would be claiming a guarantee for a screen
 *   nothing looked at.
 * - Only a complete, clean sweep passes.
 *
 * `observed` is the count of things actually measured; zero means nothing was
 * looked at at all, which is vacuous whatever else is true.
 */
function verdict(
  findings: string[],
  unmeasured: string[],
  observed: number,
  detail: string,
): { status: CheckResult['status']; detail: string; findings: string[] } {
  const status: CheckResult['status'] = findings.length
    ? 'fail'
    : unmeasured.length || observed === 0 ? 'vacuous' : 'pass';
  return {
    status,
    detail: unmeasured.length ? `${detail}; ${unmeasured.length} screen(s) could not be measured` : detail,
    findings: [...findings, ...unmeasured],
  };
}

/** Every screen a surface declares, so a check covers states and not just the happy path. */
function screensOf(dir: string, system: DesignSystem['design_system'], surfaces: SurfaceDecl[]): string[] {
  const paths: string[] = [];
  for (const surface of surfaces) {
    for (const state of surface.states ?? system.required_states) {
      const path = screenFor(dir, surface.id, state);
      if (path) paths.push(path);
    }
  }
  return paths;
}

const FOCUS_PROBE = `
/* Measure the focus rule, not the browser's guess about input modality.
 *
 * \`el.matches(':focus-visible')\` after a programmatic focus depends on the
 * modality Chromium has inferred for the page. Measured here: the identical
 * script returned true on one run and false on twelve consecutive later ones,
 * with document.activeElement correct every time. Both \`focus()\` and
 * \`focus({focusVisible:true})\` flip that way, so neither can carry a check.
 *
 * So the state is applied rather than requested. Every rule that mentions
 * :focus-visible is copied with the pseudo-class swapped for a marker class of
 * identical specificity (0,1,0), and the marker is put on each element in turn.
 * The cascade, the selectors and the declarations are the page's own; only the
 * trigger is ours. This reads cssRules, which the browser blocks for a file://
 * <link> and allows for an inlined <style> — the reason probes inline first. */
var MARK = 'aose-focus-probe';
var copied = [];
var readable = 0;
function harvest(rules) {
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (rule.selectorText && rule.selectorText.indexOf(':focus') !== -1) {
      /* :focus-visible first, so the longer pseudo-class is consumed before the
         prefix it contains. Both are specificity (0,1,0), same as the marker,
         so swapping one for the other leaves the cascade exactly as authored.
         :focus counts too: a design that rings on plain focus does show an
         indicator, and DSC-04 asks whether there is one. */
      copied.push(rule.cssText.split(':focus-visible').join('.' + MARK).split(':focus').join('.' + MARK));
    } else if (rule.cssRules) {
      harvest(rule.cssRules); // @media, @supports, @layer
    }
  }
}
for (var s = 0; s < document.styleSheets.length; s++) {
  var rules = null;
  try { rules = document.styleSheets[s].cssRules; } catch (e) { rules = null; }
  if (!rules) continue;
  readable += 1;
  harvest(rules);
}
if (copied.length) {
  var tag = document.createElement('style');
  tag.textContent = copied.join('\\n');
  document.head.appendChild(tag);
}
var out = [];
for (var el of document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')) {
  el.classList.add(MARK);
  var cs = getComputedStyle(el);
  var outlined = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  var shadowed = cs.boxShadow !== 'none';
  el.classList.remove(MARK);
  out.push({
    tag: el.tagName.toLowerCase(),
    label: (el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 40),
    visible: Boolean(outlined || shadowed),
    readable: readable,
    rules: copied.length,
  });
}
document.title = JSON.stringify(out);
`;

/**
 * DSC-04 — every interactive element shows a focus indicator.
 *
 * The colour of that indicator is DSC-02's job (the contract declares
 * `focus on background` at 3:1). This one answers the prior question: is there
 * an indicator at all, on every element a keyboard can reach.
 */
export function checkFocusVisible(
  system: DesignSystem['design_system'],
  dir: string,
  surfaces: SurfaceDecl[],
  browser = findBrowser(),
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-04');
  const base = {
    id: 'DSC-04',
    test_name: scenario?.test_name ?? 'every interactive element has a visible focus indicator',
  };
  if (!browser) {
    return { ...base, status: 'vacuous', detail: 'no browser available; focus cannot be observed', findings: [] };
  }

  const screens = screensOf(dir, system, surfaces);
  const tokens = guardTokens(dir);
  const findings: string[] = [];
  const unmeasured: string[] = [];
  let checked = 0;

  for (const screen of screens) {
    const name = screen.split('/').pop()!;
    const { rows, unmeasurable } = probeStyledArray(browser, screen, FOCUS_PROBE, tokens);
    if (unmeasurable) { unmeasured.push(`${name}: ${unmeasurable}`); continue; }
    if (!rows) { unmeasured.push(`${name}: probe did not return`); continue; }
    const elements = rows as { tag: string; label: string; visible: boolean; readable: number; rules: number }[];
    /* No stylesheet could be read, so no rule could be applied and every
       element would report unfocusable for a reason that is about access, not
       about the design. */
    if (elements.length && elements[0].readable === 0) {
      unmeasured.push(`${name}: no stylesheet could be read, so no focus rule could be applied`);
      continue;
    }
    for (const element of elements) {
      checked += 1;
      if (!element.visible) {
        findings.push(`${name}: <${element.tag}> "${element.label}" shows no focus indicator`
          + (element.rules === 0 ? ' (the page declares no :focus rule at all)' : ''));
      }
    }
  }

  return { ...base, ...verdict(findings, unmeasured, checked,
    `${checked} interactive element(s) focused across ${screens.length - unmeasured.length} of ${screens.length} screen(s)`) };
}

const MOTION_PROBE = `
const moving = [];
for (const el of document.querySelectorAll('*')) {
  const s = getComputedStyle(el);
  const t = (s.transitionDuration || '').split(',').map(v => parseFloat(v) || 0);
  const a = (s.animationDuration || '').split(',').map(v => parseFloat(v) || 0);
  const longest = Math.max(0, ...t, ...a);
  if (longest > 0) moving.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30), seconds: longest });
}
document.title = JSON.stringify(moving);
`;

/**
 * DSC-05 — reduced motion collapses every transition.
 *
 * Emulated with --force-prefers-reduced-motion, so this is what the engine
 * actually computes rather than what a media query appears to say. A screen
 * that declares no motion at all reports vacuous: there was nothing to
 * collapse, and claiming a pass would be claiming an untested guarantee.
 */
export function checkReducedMotion(
  system: DesignSystem['design_system'],
  dir: string,
  surfaces: SurfaceDecl[],
  browser = findBrowser(),
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-05');
  const base = {
    id: 'DSC-05',
    test_name: scenario?.test_name ?? 'reduced motion collapses every transition',
  };
  if (!browser) {
    return { ...base, status: 'vacuous', detail: 'no browser available; motion cannot be observed', findings: [] };
  }
  if (system.scales.motion.reduced_motion !== 'required') {
    return { ...base, status: 'vacuous', detail: 'the contract does not require reduced motion', findings: [] };
  }

  const screens = screensOf(dir, system, surfaces);
  const tokens = guardTokens(dir);
  const findings: string[] = [];
  const unmeasured: string[] = [];
  let animatedNormally = 0;

  for (const screen of screens) {
    const name = screen.split('/').pop();
    const normal = probeStyledArray(browser, screen, MOTION_PROBE, tokens);
    /* An unstyled page has no transitions to collapse, so measuring the reduced
       pass against it would report a clean sweep it never earned. */
    if (normal.unmeasurable) { unmeasured.push(`${name}: ${normal.unmeasurable}`); continue; }
    animatedNormally += normal.rows?.length ?? 0;

    const reduced = probeStyledArray(browser, screen, MOTION_PROBE, tokens, ['--force-prefers-reduced-motion']);
    if (reduced.unmeasurable) { unmeasured.push(`${name}: ${reduced.unmeasurable}`); continue; }
    for (const element of (reduced.rows ?? []) as { tag: string; cls: string; seconds: number }[]) {
      findings.push(`${name}: <${element.tag}${element.cls ? ` class="${element.cls}"` : ''}> still runs ${element.seconds}s under reduced motion`);
    }
  }

  // Nothing animates anywhere, so nothing was collapsed. That is not a pass.
  return { ...base, ...verdict(findings, unmeasured, animatedNormally,
    animatedNormally === 0
      ? `no element declares a transition across ${screens.length} screen(s); the motion scale is declared but unused`
      : `${animatedNormally} animated element(s) checked across ${screens.length - unmeasured.length} of ${screens.length} screen(s)`) };
}

const OVERFLOW_PROBE = `
const d = document.documentElement;
const past = [];
for (const el of document.querySelectorAll('*')) {
  const r = el.getBoundingClientRect();
  if (r.right > d.clientWidth + 1 || r.left < -1) {
    past.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().trim().split(/\\s+/)[0].slice(0, 24),
      right: Math.round(r.right),
    });
  }
}
document.title = JSON.stringify({ vw: d.clientWidth, sw: d.scrollWidth, past: past.slice(0, 3) });
`;

/**
 * DSC-09 — no surface overflows horizontally at any declared viewport.
 *
 * DESIGN.md listed "zero horizontal overflow at 360, 768 and 1440" among its
 * acceptance criteria, in prose, and nothing read it. The board overflowed at
 * 360 the whole time: a tally pushed past the edge by its own auto margin,
 * producing a sideways scrollbar nobody was measuring.
 *
 * The rule this defends is `recompose rather than shrink`. A surface that
 * scrolls sideways at 360 has not recomposed; it has been squeezed, and the
 * squeezing is only visible at the width nobody opens on a desktop.
 */
export function checkOverflow(
  system: DesignSystem['design_system'],
  dir: string,
  surfaces: SurfaceDecl[],
  browser = findBrowser(),
): CheckResult {
  const scenario = system.verification.scenarios.find((s) => s.id === 'DSC-09');
  const base = {
    id: 'DSC-09',
    test_name: scenario?.test_name ?? 'no surface overflows horizontally at any declared width',
  };
  if (!browser) {
    return { ...base, status: 'vacuous', detail: 'no browser available; layout cannot be measured', findings: [] };
  }

  const screens = screensOf(dir, system, surfaces);
  const widths = system.viewports;
  const tokens = guardTokens(dir);
  const findings: string[] = [];
  const unmeasured: string[] = [];
  let measured = 0;

  for (const screen of screens) {
    const name = screen.split('/').pop();
    for (const width of widths) {
      /* An unstyled page collapses to the document flow and overflows nothing,
         so measuring one would report the clean sweep this check exists to
         disprove. Layout is only meaningful once the layout rules loaded. */
      const probed = probeStyled(browser, screen, OVERFLOW_PROBE, tokens, [`--window-size=${width},900`]);
      if (probed.unmeasurable) { unmeasured.push(`${name} at ${width}px: ${probed.unmeasurable}`); continue; }
      const result = probed.value as { vw: number; sw: number; past: { tag: string; cls: string; right: number }[] } | null;
      if (!result || typeof result.sw !== 'number' || typeof result.vw !== 'number') {
        unmeasured.push(`${name} at ${width}px: probe did not return a measurement`);
        continue;
      }
      measured += 1;
      if (result.sw > result.vw) {
        const worst = Array.isArray(result.past) ? result.past[0] : undefined;
        findings.push(
          `${name} at ${width}px: scrolls to ${result.sw} in a ${result.vw} viewport`
          + (worst ? ` — <${worst.tag}${worst.cls ? ` class="${worst.cls}"` : ''}> reaches ${worst.right}` : ''),
        );
      }
    }
  }

  return { ...base, ...verdict(findings, unmeasured, measured,
    `${measured} of ${screens.length * widths.length} screen/width combination(s) measured at ${widths.join(', ')}px`) };
}
