import test from 'node:test';
import assert from 'node:assert/strict';
import { lint, lintDir, parseSignature, splitUnion, classifyReturn, resolveAlias, findCycle, topoOrder, runtimeEnvelope, runtimeConflict } from '../src/lint.ts';
import type { LintInput } from '../src/lint.ts';

const ids = (result: { errors: { id: string }[]; warnings: { id: string }[] }) =>
  ({ errors: result.errors.map((f) => f.id), warnings: result.warnings.map((f) => f.id) });

const constitution = {
  constitution: {
    name: 'N', version: 1, stack: ['node24'],
    articles: [{ id: 'ART-01', title: 'T', rule: 'R', enforcement: 'lint' as const }],
    budgets: { max_attempts: 2, max_respec: 2, timeout_minutes: 15, max_payload_tokens: 4000 },
  },
};

const spec = (over: Record<string, unknown> = {}) => ({
  module: 'core/engine', runtime: 'esm',
  requirements: [{ id: 'REQ-01', ears: 'WHEN a move is legal THE SYSTEM SHALL apply it.', verified_by: ['SC-01'] }],
  types: 'type E = \'BAD\';\ntype R =\n  | { ok: true; value: number }\n  | { ok: false; error: E };',
  contracts: { 'step(n: number): R': { kind: 'transition' as const, precondition: 'p', postcondition: 'q', errors: [] } },
  verification: { test_suite: 'test/e.test.js', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'applies a legal move' }] },
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  task: {
    target_module: 'core/engine',
    context: { constitution_articles: ['ART-01'], spec: 'core.engine.spec.yaml', upstream_exports: {} },
    deliverables: ['engine.js'],
    execution_gate: { command: 'node --test', success_criteria: 'exit 0' },
    budget: {},
    ...over,
  },
});

const manifest = (over: Record<string, unknown> = {}) => ({
  system: {
    name: 'N', constitution: 'constitution.yaml', scope_class: 'bounded' as const,
    boundaries: [{ domain: 'core/engine', responsibility: 'R', depends_on: [], exports: ['step'], spec: 'core.engine.spec.yaml', task: 'core.engine.task.yaml' }],
  },
  invariants: ['ART-01'],
  decisions: [],
  ...over,
});

const base = (over: Partial<LintInput> = {}): LintInput => ({
  dir: '/nonexistent', constitution, manifest: manifest(),
  specs: { 'core/engine': spec() }, tasks: { 'core/engine': task() },
  sources: [], ...over,
} as LintInput);

/* ---- signature parsing: the check that replaces the substring heuristic ---- */

test('parseSignature splits name, params and return type', () => {
  assert.deepEqual(parseSignature('playMove(state: EngineState, index: number): MoveResult'),
    { name: 'playMove', params: 'state: EngineState, index: number', returns: 'MoveResult' });
  assert.equal(parseSignature('notASignature'), null);
  assert.equal(parseSignature('f(a: number)'), null);
});

test('parseSignature survives nested parentheses in parameters', () => {
  const parsed = parseSignature('map(fn: (a: number) => string, xs: number[]): string[]');
  assert.equal(parsed?.name, 'map');
  assert.equal(parsed?.returns, 'string[]');
});

test('splitUnion only splits at the top level', () => {
  assert.deepEqual(splitUnion('Result<A, B | C> | Error'), ['Result<A, B | C>', 'Error']);
  assert.deepEqual(splitUnion('{ ok: true; v: A } | { ok: false; e: B }'), ['{ ok: true; v: A }', '{ ok: false; e: B }']);
});

test('classifyReturn recognizes each containment form', () => {
  assert.equal(classifyReturn('Result<State, E>'), 'result-generic');
  assert.equal(classifyReturn('{ ok: true; s: S } | { ok: false; e: E }'), 'discriminated-union');
  assert.equal(classifyReturn('State | Error'), 'error-union');
  assert.equal(classifyReturn('number'), 'bare');
});

test('a named alias is resolved against the types block, not guessed from its name', () => {
  const types = "type MoveResult =\n  | { ok: true; state: S }\n  | { ok: false; error: E };\ntype Score = number;";
  assert.equal(classifyReturn('MoveResult', types), 'discriminated-union');
  assert.equal(classifyReturn('Score', types), 'bare', 'a Result-shaped name over a bare alias must not pass');
  assert.equal(classifyReturn('MoveResult'), 'bare', 'with no types block there is nothing to resolve against');
  assert.equal(resolveAlias('Score', types), 'number');
});

/* ---- DAG: ported from the Antigravity harness's validator ---- */

test('findCycle reports the cycle path (ported: A -> B -> A)', () => {
  assert.deepEqual(findCycle(new Map([['a', ['b']], ['b', ['a']]])), ['a', 'b', 'a']);
  assert.equal(findCycle(new Map([['a', ['b']], ['b', []]])), null);
});

test('topoOrder puts dependencies before dependents', () => {
  const order = topoOrder(new Map([['ui', ['core']], ['core', []], ['infra', ['core']]]));
  assert.ok(order.indexOf('core') < order.indexOf('ui'));
  assert.ok(order.indexOf('core') < order.indexOf('infra'));
});

test('LINT-04 rejects a circular architecture (ported)', () => {
  const cyclic = manifest({
    system: { ...manifest().system, boundaries: [
      { domain: 'a', responsibility: 'A', depends_on: ['b'], exports: ['a'], spec: 'a.spec.yaml', task: 'a.task.yaml' },
      { domain: 'b', responsibility: 'B', depends_on: ['a'], exports: ['b'], spec: 'b.spec.yaml', task: 'b.task.yaml' },
    ] },
  });
  const result = lint(base({ manifest: cyclic, specs: {}, tasks: {} }));
  assert.ok(ids(result).errors.includes('LINT-04'));
});

test('LINT-03 rejects a dependency on an undeclared domain (ported)', () => {
  const ghost = manifest({
    system: { ...manifest().system, boundaries: [
      { domain: 'a', responsibility: 'A', depends_on: ['ghost'], exports: ['a'], spec: 'a.spec.yaml', task: 'a.task.yaml' },
    ] },
  });
  const result = lint(base({ manifest: ghost, specs: {}, tasks: {} }));
  assert.ok(result.errors.some((f) => f.id === 'LINT-03' && /ghost/.test(f.message)));
});

/* ---- contract rules ---- */

test('LINT-12 fails a transition that returns a bare type', () => {
  const bare = spec({ contracts: { 'step(n: number): number': { kind: 'transition', precondition: 'p', postcondition: 'q', errors: [] } } });
  const result = lint(base({ specs: { 'core/engine': bare } }));
  assert.ok(ids(result).errors.includes('LINT-12'));
});

test('LINT-13 only warns when a query returns a bare type', () => {
  const query = spec({ contracts: { 'peek(n: number): number': { kind: 'query', precondition: 'p', postcondition: 'q', errors: [] } } });
  const result = lint(base({ specs: { 'core/engine': query } }));
  assert.equal(ids(result).errors.includes('LINT-13'), false);
  assert.ok(ids(result).warnings.includes('LINT-13'));
});

test('LINT-09 rejects an error code that is absent from the types block', () => {
  const ghost = spec({ contracts: { 'step(n: number): R': { kind: 'transition', precondition: 'p', postcondition: 'q', errors: ['NOPE'] } } });
  assert.ok(ids(lint(base({ specs: { 'core/engine': ghost } }))).errors.includes('LINT-09'));
});

test('LINT-11 rejects an unparseable contract key', () => {
  const junk = spec({ contracts: { 'not a signature': { kind: 'query', precondition: 'p', postcondition: 'q', errors: [] } } });
  assert.ok(ids(lint(base({ specs: { 'core/engine': junk } }))).errors.includes('LINT-11'));
});

/* ---- requirements and traceability ---- */

test('LINT-14 rejects a requirement that is not in EARS form', () => {
  const prose = spec({ requirements: [{ id: 'REQ-01', ears: 'it should apply legal moves', verified_by: ['SC-01'] }] });
  assert.ok(ids(lint(base({ specs: { 'core/engine': prose } }))).errors.includes('LINT-14'));
});

test('LINT-15 rejects a requirement pointing at a scenario that does not exist', () => {
  const dangling = spec({ requirements: [{ id: 'REQ-01', ears: 'THE SYSTEM SHALL work.', verified_by: ['SC-99'] }] });
  assert.ok(ids(lint(base({ specs: { 'core/engine': dangling } }))).errors.includes('LINT-15'));
});

/* ---- citations ---- */

test('LINT-16 rejects a decision citing a source that is not in the ledger', () => {
  const cited = manifest({ decisions: [{ id: 'DEC-01', statement: 'S', rationale: 'R', alternatives: [], sources: ['https://arxiv.org/abs/1234.5678'] }] });
  assert.ok(ids(lint(base({ manifest: cited }))).errors.includes('LINT-16'));
});

test('LINT-17 rejects a decision citing a source that failed verification', () => {
  const url = 'https://arxiv.org/abs/2606.08272';
  const cited = manifest({ decisions: [{ id: 'DEC-01', statement: 'S', rationale: 'R', alternatives: [], sources: [url] }] });
  const result = lint(base({
    manifest: cited,
    sources: [{ url, kind: 'arxiv', title: 'Claimed title', claim: 'C', confidence: 'high', supports: [],
      verified: { status: 'mismatch', fetched_title: 'AgriGov', checked_at: 'now', detail: 'titles differ' } }],
  } as Partial<LintInput>));
  assert.ok(ids(result).errors.includes('LINT-17'));
});

test('a verified citation passes both citation rules', () => {
  const url = 'https://arxiv.org/abs/2510.12702';
  const cited = manifest({ decisions: [{ id: 'DEC-01', statement: 'S', rationale: 'R', alternatives: [], sources: [url] }] });
  const result = lint(base({
    manifest: cited,
    sources: [{ url, kind: 'arxiv', title: 'T', claim: 'C', confidence: 'medium', supports: [],
      verified: { status: 'verified', fetched_title: 'T', checked_at: 'now', detail: 'ok' } }],
  } as Partial<LintInput>));
  assert.equal(ids(result).errors.filter((id) => id === 'LINT-16' || id === 'LINT-17').length, 0);
});

/* ---- idea and task rules ---- */

test('LINT-22 requires alternatives and elicitation on architectural scope', () => {
  const idea = { idea: {
    title: 'T', goal: 'G', audience: 'A', seed_author: 'human' as const, scope_class: 'architectural' as const,
    success_criteria: ['THE SYSTEM SHALL work.'], non_goals: [], constraints: [], open_questions: [],
    alternatives_considered: [], elicitation: [],
  } };
  const result = lint(base({ idea } as Partial<LintInput>));
  assert.equal(result.errors.filter((f) => f.id === 'LINT-22').length, 2);
});

test('LINT-21 warns when the idea was seeded by an agent rather than a person', () => {
  const idea = { idea: {
    title: 'T', goal: 'G', audience: 'A', seed_author: 'agent' as const, scope_class: 'spike' as const,
    success_criteria: ['THE SYSTEM SHALL work.'], non_goals: [], constraints: [], open_questions: [],
    alternatives_considered: [], elicitation: [],
  } };
  assert.ok(ids(lint(base({ idea } as Partial<LintInput>))).warnings.includes('LINT-21'));
});

test('LINT-19 rejects a deliverable that escapes the workspace', () => {
  const escaping = task({ deliverables: ['../../etc/passwd'] });
  assert.ok(ids(lint(base({ tasks: { 'core/engine': escaping } }))).errors.includes('LINT-19'));
});

test('LINT-19 rejects an upstream export the upstream boundary never declared', () => {
  const twoDomains = manifest({
    system: { ...manifest().system, boundaries: [
      { domain: 'core/engine', responsibility: 'R', depends_on: [], exports: ['step'], spec: 'core.engine.spec.yaml', task: 'core.engine.task.yaml' },
      { domain: 'ui/client', responsibility: 'R', depends_on: ['core/engine'], exports: ['mount'], spec: 'ui.client.spec.yaml', task: 'ui.client.task.yaml' },
    ] },
  });
  const uiTask = task({ target_module: 'ui/client', context: { constitution_articles: [], spec: 'ui.client.spec.yaml', upstream_exports: { 'core/engine': ['step', 'imaginary'] } } });
  const result = lint(base({
    manifest: twoDomains,
    specs: { 'core/engine': spec(), 'ui/client': spec({ module: 'ui/client' }) },
    tasks: { 'core/engine': task(), 'ui/client': uiTask },
  }));
  assert.ok(result.errors.some((f) => f.id === 'LINT-19' && /imaginary/.test(f.message)));
});

test('LINT-23 invalidates an approval that predates an artifact edit', () => {
  const result = lint(base({
    approval: { created_at: '2026-01-01T00:00:00.000Z' },
    latestArtifactEdit: '2026-02-01T00:00:00.000Z',
  } as Partial<LintInput>));
  assert.ok(ids(result).errors.includes('LINT-23'));
});

test('LINT-24 errors when the worker payload exceeds its token budget', () => {
  const tightBudget = { ...constitution, constitution: { ...constitution.constitution, budgets: { ...constitution.constitution.budgets, max_payload_tokens: 200 } } };
  const fatSpec = spec({ types: `type E = 'BAD';\ntype R = { ok: true; value: number } | { ok: false; error: E };\n${'// a long domain vocabulary line that a real spec would carry\n'.repeat(40)}` });
  const result = lint(base({ constitution: tightBudget, specs: { 'core/engine': fatSpec } } as Partial<LintInput>));
  assert.ok(ids(result).errors.includes('LINT-24'), 'an oversized payload must fail, not merely warn');

  const roomy = lint(base({ specs: { 'core/engine': fatSpec } }));
  assert.equal(ids(roomy).errors.includes('LINT-24'), false, 'the same spec fits the default 4000-token budget');
});

/* ---- the real blueprint ---- */

test('the shipped tictactoe blueprint lints clean', () => {
  const result = lintDir('blueprints/tictactoe');
  assert.deepEqual(result.errors.map((f) => `${f.id} ${f.message}`), []);
  assert.equal(result.ok, true);
});


test('an async transition returning Promise<Result<...>> is contained, not bare', () => {
  assert.equal(classifyReturn('Promise<Result<Report, FeedError>>'), 'result-generic');
  assert.equal(classifyReturn('Promise<number>'), 'bare');
  const types = 'type Outcome = { ok: true; v: number } | { ok: false; e: string };';
  assert.equal(classifyReturn('Promise<Outcome>', types), 'discriminated-union');
});

test('LINT-09 accepts a Result imported from an upstream domain', () => {
  const imported = spec({
    types: "import type { Opportunity, Result } from '../core/opportunity';\ntype Item = { id: string };",
    contracts: { 'load(u: string): Result<Item, string>': { kind: 'transition', precondition: 'p', postcondition: 'q', errors: [] } },
  });
  const result = lint(base({ specs: { 'core/engine': imported } }));
  assert.equal(result.errors.filter((f) => f.id === 'LINT-09').length, 0);

  const neither = spec({
    types: 'type Item = { id: string };',
    contracts: { 'load(u: string): Result<Item, string>': { kind: 'transition', precondition: 'p', postcondition: 'q', errors: [] } },
  });
  assert.ok(lint(base({ specs: { 'core/engine': neither } })).errors.some((f) => f.id === 'LINT-09'));
});

/* ---- LINT-36: the DAG says what may import; the runtimes say what can ---- */

test('runtimeEnvelope reads a free-text runtime conservatively', () => {
  assert.deepEqual(runtimeEnvelope('vite, react 19, tailwind 4, typescript'),
    { browser: true, node: false, declared: true });
  assert.deepEqual(runtimeEnvelope('esm-only, node24'),
    { browser: false, node: true, declared: true });
  assert.deepEqual(runtimeEnvelope('esm-only, node24, browser'),
    { browser: true, node: true, declared: true });
  // Nothing recognisable means no claim, so the rule stays silent rather than
  // guessing at free text.
  assert.equal(runtimeEnvelope('whatever runtime').declared, false);
  assert.equal(runtimeEnvelope(undefined).declared, false);
});

test('a browser surface may not depend on a node-only module', () => {
  /* The real defect, from the real build. ui/client declared "vite, react 19,
   * tailwind 4" and depended on infra/store, which declared "esm-only,
   * node24". Both were in the blueprint; nothing compared them. The shipped
   * bundle opened with `import{DatabaseSync}from"node:sqlite"` and could not
   * load in any browser — while `vite build` exited 0, because a bundler
   * externalises specifiers it does not know, and vitest passed, because it
   * runs in Node where node:sqlite is real. */
  const browser = runtimeEnvelope('vite, react 19');
  const nodeOnly = runtimeEnvelope('esm-only, node24');
  const both = runtimeEnvelope('esm-only, node24, browser');

  assert.match(runtimeConflict(browser, nodeOnly) ?? '', /no browser runtime/);
  assert.equal(runtimeConflict(browser, both), null, 'a dual-runtime module is fine on a surface');
  assert.equal(runtimeConflict(nodeOnly, both), null, 'node importing dual-runtime is fine');
  assert.equal(runtimeConflict(nodeOnly, nodeOnly), null, 'node importing node is fine');
  // A node module importing a browser-only one is not this rule's business:
  // it is a different mistake and this rule must not claim to catch it.
  assert.equal(runtimeConflict(nodeOnly, browser), null);
  // No declaration, no claim.
  assert.equal(runtimeConflict(browser, runtimeEnvelope('mystery')), null);
});
