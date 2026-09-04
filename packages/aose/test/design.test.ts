import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { readDesignState, handoffSeed, parseLintBuild } from '../src/design.ts';
import { lint, sameOrigin, collectFixtureValues, undeclaredHosts } from '../src/lint.ts';
import { containedPath, PathEscapeError, approvalDigest } from '../src/integrity.ts';
import { converge } from '../src/converge.ts';
import type { LintInput } from '../src/lint.ts';
import type { Spec, Task } from '../src/schema.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'aose-design-'));

const constitution = {
  constitution: {
    name: 'N', version: 1, stack: ['node24'],
    articles: [{ id: 'ART-01', title: 'T', rule: 'R', enforcement: 'lint' as const }],
    allowlists: [{
      id: 'feed_sources',
      rationale: 'Only sources that publish openly and permit programmatic access. Never scrape a site whose terms forbid it.',
      entries: ['https://remotive.com/api/', 'https://hn.algolia.com/api/v1/'],
    }],
    budgets: { max_attempts: 2, max_respec: 2, timeout_minutes: 15, max_payload_tokens: 4000 },
  },
};

const spec = (over: Record<string, unknown> = {}): Spec => ({
  module: 'infra/feeds', runtime: 'esm',
  requirements: [{ id: 'REQ-01', ears: 'THE SYSTEM SHALL fetch listings.', verified_by: ['SC-01'] }],
  types: 'type Item = { id: string };',
  contracts: { 'load(u: string): Item[]': { kind: 'query', precondition: 'p', postcondition: 'q', errors: [] } },
  external_sources: [],
  verification: { test_suite: 't.js', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'n' }] },
  ...over,
} as Spec);

const task = (over: Record<string, unknown> = {}): Task => ({
  task: {
    target_module: 'infra/feeds',
    context: { constitution_articles: ['ART-01'], spec: 'feeds.spec.yaml', upstream_exports: {} },
    deliverables: ['feeds.js'],
    execution_gate: { command: 'node --test', success_criteria: 'exit 0' },
    budget: {}, ...over,
  },
} as Task);

const input = (over: Partial<LintInput> = {}): LintInput => ({
  dir: '/nonexistent', constitution,
  manifest: {
    system: { name: 'N', constitution: 'constitution.yaml', scope_class: 'bounded', boundaries: [
      { domain: 'infra/feeds', responsibility: 'R', depends_on: [], exports: ['load'], spec: 'feeds.spec.yaml', task: 'feeds.task.yaml' },
    ] },
    invariants: ['ART-01'], decisions: [],
  },
  specs: { 'infra/feeds': spec() }, tasks: { 'infra/feeds': task() }, sources: [],
  ...over,
} as LintInput);

/* ---- LINT-30: the rule that makes "no rule-breaking" checkable ---- */

test('sameOrigin accepts an entry that prefixes the source and rejects another host', () => {
  assert.equal(sameOrigin('https://remotive.com/api/remote-jobs?x=1', 'https://remotive.com/api/'), true);
  assert.equal(sameOrigin('https://remotive.com/api/remote-jobs', 'https://remotive.com/api/remote-jobs'), true);
  assert.equal(sameOrigin('https://www.upwork.com/jobs/', 'https://remotive.com/api/'), false);
});

test('LINT-30 passes a source that is on the allowlist', () => {
  const ok = spec({ external_sources: [{ url: 'https://remotive.com/api/remote-jobs', allowlist: 'feed_sources', access: 'public-api', note: '' }] });
  const result = lint(input({ specs: { 'infra/feeds': ok } }));
  assert.equal(result.errors.filter((f) => f.id === 'LINT-30').length, 0);
});

test('LINT-30 fails a source that nobody cleared, before any worker sees the spec', () => {
  const scraping = spec({ external_sources: [{ url: 'https://www.upwork.com/nx/search/jobs/', allowlist: 'feed_sources', access: 'public-feed', note: '' }] });
  const result = lint(input({ specs: { 'infra/feeds': scraping } }));
  const finding = result.errors.find((f) => f.id === 'LINT-30');
  assert.ok(finding, 'an uncleared host must fail the blueprint');
  assert.match(finding!.message, /is not on the "feed_sources" allowlist/);
  assert.match(finding!.message, /Never scrape a site whose terms forbid it/, 'the rationale travels with the failure');
});

test('LINT-30 fails a reference to an allowlist the constitution never defined', () => {
  const ghost = spec({ external_sources: [{ url: 'https://example.com/x', allowlist: 'imaginary', access: 'public-feed', note: '' }] });
  assert.ok(lint(input({ specs: { 'infra/feeds': ghost } })).errors.some((f) => f.id === 'LINT-30' && /does not define/.test(f.message)));
});

test('LINT-30 warns when an authenticated source does not say what credential it needs', () => {
  const authed = spec({ external_sources: [{ url: 'https://remotive.com/api/private', allowlist: 'feed_sources', access: 'authenticated', note: 'someday' }] });
  assert.ok(lint(input({ specs: { 'infra/feeds': authed } })).warnings.some((f) => f.id === 'LINT-30'));
});

/* ---- LINT-27 / 28: the design binding ---- */

test('LINT-27 warns when a surface domain has no design binding at all', () => {
  const uiInput = input({
    manifest: { ...input().manifest!, system: { ...input().manifest!.system, boundaries: [
      { domain: 'ui/client', responsibility: 'R', depends_on: [], exports: ['mount'], spec: 'ui.spec.yaml', task: 'ui.task.yaml' },
    ] } },
    specs: { 'ui/client': spec({ module: 'ui/client' }) },
    tasks: { 'ui/client': task({ target_module: 'ui/client' }) },
  });
  assert.ok(lint(uiInput).warnings.some((f) => f.id === 'LINT-27' && /invent the visual language/.test(f.message)));
});

test('LINT-27 fails when the named design contract does not exist', () => {
  const bound = spec({ module: 'ui/client', design: { contract: 'design/DESIGN.md', surfaces: ['board'] } });
  const uiInput = input({
    manifest: { ...input().manifest!, system: { ...input().manifest!.system, boundaries: [
      { domain: 'ui/client', responsibility: 'R', depends_on: [], exports: ['mount'], spec: 'ui.spec.yaml', task: 'ui.task.yaml' },
    ] } },
    specs: { 'ui/client': bound }, tasks: { 'ui/client': task({ target_module: 'ui/client' }) },
  });
  assert.ok(lint(uiInput).errors.some((f) => f.id === 'LINT-27' && /does not exist/.test(f.message)));
});

test('LINT-28 rejects a handoff stamped as a forced export', () => {
  const root = dir();
  mkdirSync(join(root, 'design', 'handoff'), { recursive: true });
  writeFileSync(join(root, 'design', 'DESIGN.md'), '# contract');
  writeFileSync(join(root, 'design', 'handoff', 'BRIEF.md'), 'This export is provisional and did not pass the gate.');
  writeFileSync(join(root, 'design', 'DESIGN.md'), '# contract');
  const bound = spec({ module: 'ui/client', design: { contract: 'design/DESIGN.md', handoff: 'design/handoff', surfaces: ['board'] } });
  const uiInput = input({
    dir: root,
    manifest: { ...input().manifest!, system: { ...input().manifest!.system, boundaries: [
      { domain: 'ui/client', responsibility: 'R', depends_on: [], exports: ['mount'], spec: 'ui.spec.yaml', task: 'ui.task.yaml' },
    ] } },
    specs: { 'ui/client': bound }, tasks: { 'ui/client': task({ target_module: 'ui/client' }) },
  });
  assert.ok(lint(uiInput).errors.some((f) => f.id === 'LINT-28' && /forced export/.test(f.message)));
});

/* ---- design state and the studio gate ---- */

test('readDesignState reports every blocker that keeps the gate shut', () => {
  const root = join(dir(), 'design');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'DESIGN.md'), '# contract');
  writeFileSync(join(root, 'design.json'), JSON.stringify({ screens: [
    { id: 'board', decision: { state: 'approved' }, stale: false },
    { id: 'invoice', decision: { state: 'pending' }, stale: false },
    { id: 'inbox', decision: { state: 'approved' }, stale: true },
  ] }));
  const state = readDesignState(root);
  assert.equal(state.total_screens, 3);
  assert.equal(state.approved_screens, 2);
  assert.equal(state.gate_can_pass, false);
  assert.ok(state.blockers.some((b) => /not approved/.test(b)));
  assert.ok(state.blockers.some((b) => /stale/.test(b)));
});

test('readDesignState opens the gate only when every screen is approved and current', () => {
  const root = join(dir(), 'design');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'DESIGN.md'), '# contract');
  writeFileSync(join(root, 'design.json'), JSON.stringify({ screens: [{ id: 'board', decision: { state: 'approved' }, stale: false }] }));
  assert.equal(readDesignState(root).gate_can_pass, true);
});

test('handoffSeed hands a worker the frozen contract files and nothing else', () => {
  const blueprint = dir();
  mkdirSync(join(blueprint, 'design', 'handoff'), { recursive: true });
  for (const file of ['BRIEF.md', 'tokens.css', 'screens.json', 'secret-notes.txt']) {
    writeFileSync(join(blueprint, 'design', 'handoff', file), 'x');
  }
  const seed = handoffSeed(blueprint, 'design/handoff');
  assert.deepEqual(seed.map((s) => s.path).sort(), ['design/BRIEF.md', 'design/screens.json', 'design/tokens.css']);
});

test('a handoff path that escapes the project is refused rather than seeded', () => {
  const blueprint = dir();
  mkdirSync(join(blueprint, 'design'), { recursive: true });
  const neighbour = dir();
  mkdirSync(join(neighbour, 'handoff'), { recursive: true });
  writeFileSync(join(neighbour, 'handoff', 'BRIEF.md'), 'another project\u0027s approved brief');

  for (const escape of ['../../../etc', `../${basename(neighbour)}/handoff`, '/etc']) {
    assert.throws(() => handoffSeed(blueprint, escape), PathEscapeError,
      `"${escape}" must not seed a cold worker`);
  }
});

test('containedPath allows a real subpath and refuses every way out', () => {
  const root = dir();
  mkdirSync(join(root, 'design', 'handoff'), { recursive: true });
  assert.equal(containedPath(root, 'design/handoff'), join(realpathSync(root), 'design', 'handoff'));
  for (const escape of ['..', '../sibling', 'design/../../outside', '/etc/passwd']) {
    assert.throws(() => containedPath(root, escape), PathEscapeError, escape);
  }
});

test('a handoff with no gate receipt is unproven rather than assumed to have passed', () => {
  const root = join(dir(), 'design');
  mkdirSync(join(root, 'handoff'), { recursive: true });
  writeFileSync(join(root, 'DESIGN.md'), '# contract');
  writeFileSync(join(root, 'design.json'), JSON.stringify({ screens: [{ id: 'a', decision: { state: 'approved' }, stale: false }] }));
  // A hand-authored BRIEF.md used to be enough to read as "gate passed".
  writeFileSync(join(root, 'handoff', 'BRIEF.md'), 'Everything here was definitely approved.');
  const unproven = readDesignState(root);
  assert.equal(unproven.handoff_passed_gate, null);
  assert.ok(unproven.blockers.some((b) => /no gate.json receipt/.test(b)));

  writeFileSync(join(root, 'handoff', 'gate.json'), JSON.stringify({ passed: true, forced: false, digest: 'abc' }));
  const proven = readDesignState(root);
  assert.equal(proven.handoff_passed_gate, true);
  assert.equal(proven.handoff_digest, 'abc');

  writeFileSync(join(root, 'handoff', 'gate.json'), JSON.stringify({ passed: true, forced: true, digest: 'abc' }));
  assert.equal(readDesignState(root).handoff_passed_gate, false, 'a forced export is not a passed gate');
});

test('collectFixtureValues gathers the invented values a handoff quarantined', () => {
  const root = dir();
  mkdirSync(join(root, 'fixtures'), { recursive: true });
  writeFileSync(join(root, 'fixtures', 'invented.json'), JSON.stringify({ client: 'Aurora Labs', rate: 145, nested: { quote: 'Best contractor we ever hired' } }));
  const values = collectFixtureValues(join(root, 'fixtures'));
  assert.ok(values.includes('Aurora Labs'));
  assert.ok(values.includes('145'));
  assert.ok(values.includes('Best contractor we ever hired'));
});

test('parseLintBuild reports the problems a failing contract check printed', () => {
  const failing = parseLintBuild({ ok: false, status: 1, command: 'x', stdout: 'token drift: --ls-primary\nall good here', stderr: 'error: colour literal #ff0000' });
  assert.equal(failing.passed, false);
  assert.equal(failing.problems.length, 2);
  assert.equal(parseLintBuild({ ok: true, status: 0, command: 'x', stdout: 'ok', stderr: '' }).passed, true);
});

/* ---- the fifth converge pillar ---- */

test('design fidelity only appears for a domain bound to a design contract', () => {
  const root = dir();
  writeFileSync(join(root, 'feeds.js'), 'export function load(){return [];}');
  const common = {
    domain: 'infra/feeds', worktree: root, spec: spec(), task: task().task,
    gateExit: 0, gateStdout: 'n', gateStdoutSha: 'a'.repeat(64),
    sources: [], citedUrls: [], approvalAt: '2026-01-01', firstDispatchAt: '2026-01-02',
  };
  assert.equal(converge(common).pillars.length, 4);
  assert.equal(converge({ ...common, design: { bound: false, handoff_exists: false, handoff_passed_gate: null, lint_build_passed: null, lint_build_problems: [], fixture_leaks: [], screenshots: [] } }).pillars.length, 4);

  const bound = converge({ ...common, design: {
    bound: true, handoff_exists: true, handoff_passed_gate: true,
    lint_build_passed: true, lint_build_problems: [], fixture_leaks: [], screenshots: [],
  } });
  assert.equal(bound.pillars.length, 5);
  assert.equal(bound.pillars[4].name, 'Design fidelity');
  assert.equal(bound.pillars[4].score, 100);
});

test('a shipped fixture value and a forced handoff both cost the design pillar', () => {
  const root = dir();
  writeFileSync(join(root, 'feeds.js'), 'export function load(){return [];}');
  const report = converge({
    domain: 'infra/feeds', worktree: root, spec: spec(), task: task().task,
    gateExit: 0, gateStdout: 'n', gateStdoutSha: 'a'.repeat(64),
    sources: [], citedUrls: [], approvalAt: '2026-01-01', firstDispatchAt: '2026-01-02',
    design: { bound: true, handoff_exists: true, handoff_passed_gate: false, lint_build_passed: false, lint_build_problems: ['token drift'], fixture_leaks: ['Aurora Labs'] , screenshots: [] },
  });
  const pillar = report.pillars.find((p) => p.name === 'Design fidelity')!;
  assert.equal(pillar.score, 15, 'only the partial credit for a handoff existing at all');
  assert.equal(report.passed, false);
});


/* ---- LINT-31: the built code, not only the declaration ---- */

test('undeclaredHosts ignores allowlisted and local hosts and reports the rest', () => {
  const allowed = ['https://remotive.com/api/remote-jobs', 'https://hn.algolia.com/api/v1/'];
  assert.deepEqual(undeclaredHosts('fetch("https://remotive.com/api/remote-jobs?limit=10")', allowed), []);
  assert.deepEqual(undeclaredHosts('await fetch("http://localhost:5173/preview")', allowed), []);
  assert.deepEqual(undeclaredHosts('fetch("https://www.upwork.com/nx/search/jobs/")', allowed), ['www.upwork.com']);
});

test('LINT-31 fails code that reaches a host no allowlist cleared', () => {
  const root = dir();
  writeFileSync(join(root, 'feeds.js'), 'export async function load(){ return fetch("https://www.upwork.com/nx/search/jobs/"); }');
  const declared = spec({ external_sources: [{ url: 'https://remotive.com/api/remote-jobs', allowlist: 'feed_sources', access: 'public-api', note: '' }] });
  const result = lint(input({ dir: root, specs: { 'infra/feeds': declared } }));
  const finding = result.errors.find((f) => f.id === 'LINT-31');
  assert.ok(finding, 'a declared-clean spec whose code reaches elsewhere must still fail');
  assert.match(finding!.message, /www\.upwork\.com/);
});

/* ---- content addressing ---- */

test('the approval digest changes when any covered file changes', () => {
  const root = dir();
  writeFileSync(join(root, 'constitution.yaml'), 'a: 1');
  writeFileSync(join(root, 'idea.yaml'), 'b: 2');
  const before = approvalDigest(root).value;
  assert.equal(approvalDigest(root).value, before, 'the digest is stable for unchanged content');

  writeFileSync(join(root, 'idea.yaml'), 'b: 3');
  assert.notEqual(approvalDigest(root).value, before);
});

test('the approval digest covers the design directory too', () => {
  const root = dir();
  writeFileSync(join(root, 'constitution.yaml'), 'a: 1');
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(join(root, 'design', 'DESIGN.md'), '# tokens v1');
  const before = approvalDigest(root, [], join(root, 'design')).value;

  writeFileSync(join(root, 'design', 'DESIGN.md'), '# tokens v2');
  assert.notEqual(approvalDigest(root, [], join(root, 'design')).value, before,
    'changing the design contract must invalidate an approval that covered it');
});
