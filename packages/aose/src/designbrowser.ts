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
import { join, resolve } from 'node:path';
import type { CheckResult, SurfaceDecl } from './designcheck.ts';
import { screenFor } from './designcheck.ts';
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
export function probe(
  browser: string,
  screenPath: string,
  script: string,
  flags: string[] = [],
): unknown {
  const probePath = screenPath.replace(/\.html$/, '.aose-probe.html');
  const html = readFileSync(screenPath, 'utf8')
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
  } catch { return null; }
  finally { try { unlinkSync(probePath); } catch { /* best effort */ } }
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
const out = [];
for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')) {
  el.focus();
  const s = getComputedStyle(el);
  const outlined = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const shadowed = s.boxShadow !== 'none';
  out.push({
    tag: el.tagName.toLowerCase(),
    label: (el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 40),
    visible: Boolean(el.matches(':focus-visible') && (outlined || shadowed)),
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
  const findings: string[] = [];
  let checked = 0;

  for (const screen of screens) {
    const result = probe(browser, screen, FOCUS_PROBE) as { tag: string; label: string; visible: boolean }[] | null;
    if (!result) { findings.push(`${screen.split('/').pop()}: probe did not return`); continue; }
    for (const element of result) {
      checked += 1;
      if (!element.visible) {
        findings.push(`${screen.split('/').pop()}: <${element.tag}> "${element.label}" shows no focus indicator`);
      }
    }
  }

  return {
    ...base,
    status: checked === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: `${checked} interactive element(s) focused across ${screens.length} screen(s)`,
    findings,
  };
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
  const findings: string[] = [];
  let animatedNormally = 0;

  for (const screen of screens) {
    const name = screen.split('/').pop();
    const normal = probe(browser, screen, MOTION_PROBE) as { tag: string; cls: string; seconds: number }[] | null;
    animatedNormally += normal?.length ?? 0;

    const reduced = probe(browser, screen, MOTION_PROBE, ['--force-prefers-reduced-motion']) as
      { tag: string; cls: string; seconds: number }[] | null;
    for (const element of reduced ?? []) {
      findings.push(`${name}: <${element.tag}${element.cls ? ` class="${element.cls}"` : ''}> still runs ${element.seconds}s under reduced motion`);
    }
  }

  return {
    ...base,
    // Nothing animates anywhere, so nothing was collapsed. That is not a pass.
    status: animatedNormally === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: animatedNormally === 0
      ? `no element declares a transition across ${screens.length} screen(s); the motion scale is declared but unused`
      : `${animatedNormally} animated element(s) checked across ${screens.length} screen(s)`,
    findings,
  };
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
  const findings: string[] = [];
  let measured = 0;

  for (const screen of screens) {
    const name = screen.split('/').pop();
    for (const width of widths) {
      const result = probe(browser, screen, OVERFLOW_PROBE, [`--window-size=${width},900`]) as
        { vw: number; sw: number; past: { tag: string; cls: string; right: number }[] } | null;
      if (!result) { findings.push(`${name} at ${width}px: probe did not return`); continue; }
      measured += 1;
      if (result.sw > result.vw) {
        const worst = result.past[0];
        findings.push(
          `${name} at ${width}px: scrolls to ${result.sw} in a ${result.vw} viewport`
          + (worst ? ` — <${worst.tag}${worst.cls ? ` class="${worst.cls}"` : ''}> reaches ${worst.right}` : ''),
        );
      }
    }
  }

  return {
    ...base,
    status: measured === 0 ? 'vacuous' : findings.length ? 'fail' : 'pass',
    detail: `${screens.length} screen(s) measured at ${widths.join(', ')}px`,
    findings,
  };
}
