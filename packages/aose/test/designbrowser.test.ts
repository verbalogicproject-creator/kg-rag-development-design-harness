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
import { checkFocusVisible, checkReducedMotion, checkOverflow, findBrowser, probe, inlineStylesheets } from '../src/designbrowser.ts';
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

function surfaceDir(files: Record<string, string>, tokensCss?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aose-states-'));
  mkdirSync(join(dir, 'design', 'screens'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'design', 'screens', name), body);
  }
  // Written only when a test needs the guard active: `guardTokens` reads token
  // names from here, and with no tokens.css there is nothing to guard against.
  if (tokensCss !== undefined) writeFileSync(join(dir, 'design', 'tokens.css'), tokensCss);
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
  // Measured-of-total, not just total: a sweep that skipped a screen has to be
  // visible here, or a partial pass reads exactly like a complete one.
  assert.match(result.detail, /^24 of 24 screen\/width combination\(s\) measured at 360, 768, 1440px$/);
});

test('a probe that returns a non-array is reported, not crashed on', () => {
  // This was a real crash, not a hypothetical: casting probe() to an array and
  // iterating it threw "result is not iterable" and took the whole design gate
  // down instead of reporting that one screen could not be measured. A cast is
  // a claim; the check is what makes it safe.
  const dir = surfaceDir({
    // A screen whose own <title> is valid JSON but not the shape expected.
    'board.html': '<html><head><title>{"not":"an array"}</title></head><body><button>x</button></body></html>',
  });
  const system = loadDesignSystem(DIR);

  const focus = checkFocusVisible(system, dir, [{ id: 'board', states: ['populated'] }], browser ?? '/nonexistent');
  assert.notEqual(focus.status, 'pass', 'an unreadable probe must never read as a pass');
  assert.doesNotThrow(() => checkOverflow(system, dir, [{ id: 'board', states: ['populated'] }], browser ?? '/nonexistent'));
});


/* ---- the unstyled-page guard ---- */

/**
 * The flake this guard exists for, reproduced deterministically.
 *
 * Under full-suite load a `file://` stylesheet intermittently failed to load.
 * The DOM was complete and the labels were right, so the probe returned a full
 * array — but `outline: 2px solid var(--ls-color-focus)` is invalid at
 * computed-value time once the token is missing, so the ring did not change
 * colour, it disappeared. DSC-04 then reported every interactive element of
 * that screen as a focus defect. Measured directly: with tokens.css absent,
 * profile-empty.html reports all 8 of its elements unfocusable while
 * `:focus-visible` still matches on every one.
 *
 * Here the same condition is forced: the tokens file exists on disk, so the
 * harness reads real names from it, but the screen links a stylesheet the
 * browser cannot fetch.
 */
const GUARDED_SCREEN = `<html><head>
  <link rel="stylesheet" href="../tokens-not-delivered.css">
  <style>
    :is(a, button):focus-visible { outline: 2px solid var(--ls-color-focus); outline-offset: 2px; }
  </style>
</head><body>
  <a href="#a">Board</a><a href="#b">Inbox</a><button>Save profile</button>
</body></html>`;

const TOKENS = ':root { --ls-color-focus: #17527D; --ls-color-bg: #fff; }';

test('an unstyled page is reported as unmeasured, never as a design defect', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  const dir = surfaceDir({ 'board.html': GUARDED_SCREEN }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);

  assert.equal(result.status, 'vacuous', `got ${result.status}: ${result.findings.join(' | ')}`);
  assert.notEqual(result.status, 'fail', 'an unread stylesheet is not a missing focus ring');
  assert.match(result.findings.join('\n'), /stylesheet did not load/);
  // The exact string the old code produced. If it comes back, the guard is off.
  assert.doesNotMatch(result.findings.join('\n'), /shows no focus indicator/);
});

test('the guard does not fire on a page whose tokens did load', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // The other half, and the one that matters most: a guard that fired always
  // would silently turn all three browser checks vacuous and nobody would
  // notice, because vacuous does not fail a build.
  const dir = surfaceDir({
    'board.html': GUARDED_SCREEN.replace('../tokens-not-delivered.css', '../tokens.css'),
  }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);

  assert.equal(result.status, 'pass', result.findings.join('\n'));
  assert.match(result.detail, /3 interactive element\(s\) focused across 1 of 1 screen/);
});

test('a real defect on a page that loaded outranks a page that did not', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // The ordering rule in `verdict`. An incomplete sweep must never mask a
  // defect that was actually observed, or the guard becomes a way to hide
  // failures by breaking a stylesheet.
  const dir = surfaceDir({
    // loads its tokens, and genuinely has no focus style
    'board.html': '<html><head><link rel="stylesheet" href="../tokens.css">'
      + '<style>a:focus-visible{outline:none}</style></head>'
      + '<body><a href="#a">Board</a></body></html>',
    // cannot load its tokens
    'inbox.html': GUARDED_SCREEN,
  }, TOKENS);

  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [
    { id: 'board', states: ['populated'] },
    { id: 'inbox', states: ['populated'] },
  ], browser!);

  assert.equal(result.status, 'fail', 'a measured defect wins over an unmeasured screen');
  const text = result.findings.join('\n');
  assert.match(text, /board\.html: <a> "Board" shows no focus indicator/);
  assert.match(text, /inbox\.html: .*stylesheet did not load/);
  assert.match(result.detail, /1 screen\(s\) could not be measured/);
});


/* ---- inlining, the reason the guard rarely has to fire ---- */

test('a relative stylesheet is inlined into the copy under test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-inline-'));
  writeFileSync(join(dir, 'screen.css'), '.a { color: red; }');
  const out = inlineStylesheets('<link rel="stylesheet" href="screen.css">', dir);
  assert.match(out, /<style data-aose-inlined="screen\.css">/);
  assert.match(out, /\.a \{ color: red; \}/);
  assert.doesNotMatch(out, /<link/, 'the link must be replaced, not duplicated');
});

test('sheets that would change meaning when moved are left alone', () => {
  // url() and @import resolve against the stylesheet's own location. Inlining
  // one silently repoints every reference in it at the document instead.
  const dir = mkdtempSync(join(tmpdir(), 'aose-inline-'));
  writeFileSync(join(dir, 'a.css'), '@font-face { src: url(./f.woff2); }');
  writeFileSync(join(dir, 'b.css'), '@import "other.css";');
  for (const name of ['a.css', 'b.css']) {
    const tag = `<link rel="stylesheet" href="${name}">`;
    assert.equal(inlineStylesheets(tag, dir), tag, `${name} must keep its link`);
  }
});

test('what cannot be inlined keeps its link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-inline-'));
  for (const href of ['https://cdn.example/x.css', '//cdn.example/x.css', 'gone.css']) {
    const tag = `<link rel="stylesheet" href="${href}">`;
    assert.equal(inlineStylesheets(tag, dir), tag, href);
  }
  // A non-stylesheet link is not ours to touch.
  const icon = '<link rel="icon" href="favicon.ico">';
  assert.equal(inlineStylesheets(icon, dir), icon);
});

test('a stylesheet cannot break out of the style block it is inlined into', () => {
  // Defence against the file being able to inject markup into the page that
  // measures it. `</style>` is not valid CSS, so refusing is free.
  const dir = mkdtempSync(join(tmpdir(), 'aose-inline-'));
  writeFileSync(join(dir, 'evil.css'), '.a{}</style><script>document.title="owned"</script>');
  const tag = '<link rel="stylesheet" href="evil.css">';
  assert.equal(inlineStylesheets(tag, dir), tag);
});

test('inlining leaves the cascade order intact', () => {
  // Two sheets where the second overrides the first. If inlining reordered
  // them, every computed colour this module measures would be the wrong one.
  const dir = mkdtempSync(join(tmpdir(), 'aose-inline-'));
  writeFileSync(join(dir, 'one.css'), '.a { color: red; }');
  writeFileSync(join(dir, 'two.css'), '.a { color: blue; }');
  const out = inlineStylesheets(
    '<link rel="stylesheet" href="one.css"><link rel="stylesheet" href="two.css">', dir);
  assert.ok(out.indexOf('color: red') < out.indexOf('color: blue'), 'order must be preserved');
});


/* ---- DSC-04 measures the rule, not the browser's modality guess ---- */

test('a ring declared only under :focus-visible is found', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // The regression guard for the flake. Reading `el.matches(':focus-visible')`
  // returned false on twelve consecutive probes of a page that plainly has a
  // ring, so a check built on it reported every element defective. This must
  // pass on every run, not most of them.
  const dir = surfaceDir({
    'board.html': '<html><head><link rel="stylesheet" href="../tokens.css">'
      + '<style>a:focus-visible { outline: 2px solid var(--ls-color-focus); }</style>'
      + '</head><body><a href="#a">Board</a></body></html>',
  }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'pass', result.findings.join('\n'));
});

test('a ring declared under plain :focus counts as an indicator', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // DSC-04 asks whether there is an indicator, not which pseudo-class spells
  // it. Failing this design would be a false alarm.
  const dir = surfaceDir({
    'board.html': '<html><head><link rel="stylesheet" href="../tokens.css">'
      + '<style>a:focus { box-shadow: 0 0 0 2px var(--ls-color-focus); }</style>'
      + '</head><body><a href="#a">Board</a></body></html>',
  }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'pass', result.findings.join('\n'));
});

test('a page with no focus rule fails and says that is why', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  const dir = surfaceDir({
    'board.html': '<html><head><link rel="stylesheet" href="../tokens.css">'
      + '<style>a { color: blue; }</style></head><body><a href="#a">Board</a></body></html>',
  }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0], /declares no :focus rule at all/);
});

test('a focus rule inside a media query is still found', {
  skip: browser ? false : 'no chromium cached',
}, () => {
  // Rules nest. A harvest that only walked the top level would miss these and
  // report a false defect on every element the media query covers.
  const dir = surfaceDir({
    'board.html': '<html><head><link rel="stylesheet" href="../tokens.css"><style>'
      + '@media (min-width: 1px) { a:focus-visible { outline: 2px solid var(--ls-color-focus); } }'
      + '</style></head><body><a href="#a">Board</a></body></html>',
  }, TOKENS);
  const result = checkFocusVisible(loadDesignSystem(DIR), dir, [{ id: 'board', states: ['populated'] }], browser!);
  assert.equal(result.status, 'pass', result.findings.join('\n'));
});
