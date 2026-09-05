/**
 * The browser-backed design checks.
 *
 * The property these defend is the one that is easiest to lose: when the check
 * cannot look, it must say so. A focus check that reports `pass` on a machine
 * with no browser is worse than no check at all, because it produces evidence
 * nobody earned and every downstream score trusts it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFocusVisible, checkReducedMotion, checkOverflow, findBrowser, probe } from '../src/designbrowser.ts';
import { loadDesignSystem, checkStates, screenFor } from '../src/designcheck.ts';

const DIR = 'blueprints/freelance-dashboard';
const SURFACES = [
  { id: 'pipeline-board', states: ['empty', 'populated'] },
  { id: 'scout-inbox', states: ['empty', 'populated'] },
];

/* ---- the no-browser contract ---- */

test('DSC-04 reports vacuous, never pass, when no browser is available', () => {
  const result = checkFocusVisible(loadDesignSystem(DIR), DIR, SURFACES, null);
  assert.equal(result.status, 'vacuous');
  assert.notEqual(result.status, 'pass', 'a check that could not look has not looked');
  assert.match(result.detail, /no browser available/);
});

test('DSC-05 reports vacuous, never pass, when no browser is available', () => {
  const result = checkReducedMotion(loadDesignSystem(DIR), DIR, SURFACES, null);
  assert.equal(result.status, 'vacuous');
  assert.match(result.detail, /no browser available/);
});

test('DSC-05 is vacuous when the contract does not require reduced motion', () => {
  const system = structuredClone(loadDesignSystem(DIR));
  system.scales.motion.reduced_motion = 'optional';
  const result = checkReducedMotion(system, DIR, SURFACES, '/nonexistent/browser');
  assert.equal(result.status, 'vacuous');
  assert.match(result.detail, /does not require reduced motion/);
});

/* ---- DSC-03: states ---- */

function surfaceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'aose-states-'));
  mkdirSync(join(dir, 'design', 'screens'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'design', 'screens', name), body);
  }
  return dir;
}

test('DSC-03 fails when a surface declares an empty state and no screen proves it', () => {
  const dir = surfaceDir({ 'board.html': '<html><body><button>x</button></body></html>' });
  const result = checkStates(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['empty', 'populated'] }]);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /declares the empty state but no screen proves it/);
});

test('DSC-03 fails an empty state that only narrates the absence', () => {
  // REQ-04 asks the empty state to name the next action. Prose describing what
  // would appear here is the thing it exists to replace.
  const dir = surfaceDir({
    'board.html': '<html><body><button>x</button></body></html>',
    'board-empty.html': '<html><body><p>No opportunities yet. Run a scout to find some.</p></body></html>',
  });
  const result = checkStates(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['empty', 'populated'] }]);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /describes no reachable action/);
});

test('DSC-03 fails an empty state that ships placeholder rows', () => {
  // ART-08: plausible-looking invention is the failure. An empty surface that
  // renders sample cards is lying about having data.
  const dir = surfaceDir({
    'board.html': '<html><body><button>x</button></body></html>',
    'board-empty.html': '<html><body><button>Add</button><div class="card">Sample</div><div class="card">Sample</div></body></html>',
  });
  const result = checkStates(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['empty', 'populated'] }]);
  assert.equal(result.status, 'fail');
  assert.match(result.findings.join('\n'), /ships 2 placeholder row\(s\)/);
});

test('DSC-03 passes an empty state that offers a real action and no rows', () => {
  const dir = surfaceDir({
    'board.html': '<html><body><button>x</button></body></html>',
    'board-empty.html': '<html><body><textarea></textarea><button>Add opportunity</button></body></html>',
  });
  const result = checkStates(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['empty', 'populated'] }]);
  assert.equal(result.status, 'pass');
  assert.match(result.detail, /2\/2 surface-states have a screen/);
});

test('screenFor follows the naming convention and reports absence honestly', () => {
  assert.ok(screenFor(DIR, 'pipeline-board', 'populated')?.endsWith('pipeline-board.html'));
  assert.ok(screenFor(DIR, 'pipeline-board', 'empty')?.endsWith('pipeline-board-empty.html'));
  assert.equal(screenFor(DIR, 'pipeline-board', 'loading'), null);
});

/* ---- the real engine, when one is present ---- */

const browser = findBrowser();

test('the shipped screens all show a focus indicator', { skip: browser ? false : 'no chromium cached' }, () => {
  const system = loadDesignSystem(DIR);
  const result = checkFocusVisible(system, DIR, [
    { id: 'pipeline-board', states: ['empty', 'populated'] },
    { id: 'scout-inbox', states: ['empty', 'populated'] },
    { id: 'opportunity-detail', states: ['empty', 'populated'] },
    { id: 'profile', states: ['empty', 'populated'] },
  ], browser!);

  assert.equal(result.status, 'pass', result.findings.join('\n'));
  // If this count collapses, the probe stopped finding elements rather than
  // the screens becoming simpler — the failure a bare `pass` would hide.
  const focused = Number(/^(\d+) interactive/.exec(result.detail)?.[1] ?? 0);
  assert.ok(focused > 40, `expected the probe to reach many elements, focused ${focused}`);
});

test('reduced motion collapses every declared transition', { skip: browser ? false : 'no chromium cached' }, () => {
  const result = checkReducedMotion(loadDesignSystem(DIR), DIR, [
    { id: 'pipeline-board', states: ['empty', 'populated'] },
    { id: 'scout-inbox', states: ['empty', 'populated'] },
  ], browser!);
  assert.equal(result.status, 'pass', result.findings.join('\n'));
  assert.match(result.detail, /animated element\(s\) checked/);
});

test('a screen with a transition that survives reduced motion is caught', { skip: browser ? false : 'no chromium cached' }, () => {
  // The adversarial case: a rule that animates and no reduced-motion override.
  const dir = surfaceDir({
    'board.html': `<html><body><style>
      .x { transition: opacity 300ms linear; }
    </style><div class="x">moves</div></body></html>`,
  });
  const result = checkReducedMotion(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /still runs 0\.3s under reduced motion/);
});

test('probe leaves the screen it tested unmodified', { skip: browser ? false : 'no chromium cached' }, () => {
  const dir = surfaceDir({ 'board.html': '<html><body><p id="a">hello</p></body></html>' });
  const path = join(dir, 'design', 'screens', 'board.html');
  const before = readFileSync(path, 'utf8');
  probe(browser!, path, 'document.title = JSON.stringify({ok:true});');
  assert.equal(readFileSync(path, 'utf8'), before, 'testing a screen must not edit it');
});

/* ---- DSC-09: horizontal overflow ---- */

test('DSC-09 reports vacuous, never pass, with no browser', () => {
  const result = checkOverflow(loadDesignSystem(DIR), DIR, SURFACES, null);
  assert.equal(result.status, 'vacuous');
  assert.match(result.detail, /no browser available/);
});

test('DSC-09 catches a surface that scrolls sideways at a narrow width', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // The real bug, reproduced: a header row that cannot wrap, with an element
  // pushed past the edge by its own auto margin. It is invisible at 1440 and
  // produces a scrollbar at 360 — the width nobody opens on a desktop.
  const dir = surfaceDir({
    'board.html': `<html><body><style>
      body { margin: 0; }
      .head { display: flex; gap: 16px; flex-wrap: nowrap; }
      .head > * { flex: 0 0 auto; white-space: nowrap; margin: 0; }
      .tally { margin-inline-start: auto; }
    </style><div class="head"><h2>A rather long heading indeed</h2><button>Add opportunity</button><p class="tally">4 open &middot; $12,400 in play</p></div></body></html>`,
  });
  const system = structuredClone(loadDesignSystem(DIR));
  system.viewports = [360, 1440];

  const result = checkOverflow(system, dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((f) => /at 360px: scrolls to \d+ in a \d+ viewport/.test(f)),
    `expected a 360px overflow finding, got: ${result.findings.join(' | ')}`);
  assert.equal(result.findings.some((f) => /at 1440px/.test(f)), false,
    'and it must not fire at a width where the layout fits');
});

test('the shipped screens fit every declared viewport', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  const system = loadDesignSystem(DIR);
  const result = checkOverflow(system, DIR, [
    { id: 'pipeline-board', states: ['empty', 'populated'] },
    { id: 'scout-inbox', states: ['empty', 'populated'] },
    { id: 'opportunity-detail', states: ['empty', 'populated'] },
    { id: 'profile', states: ['empty', 'populated'] },
  ], browser!);

  assert.equal(result.status, 'pass', result.findings.join('\n'));
  assert.match(result.detail, /8 screen\(s\) measured at 360, 768, 1440px/);
});
