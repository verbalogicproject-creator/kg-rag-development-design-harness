import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { dispatch, createWorkspace, previewCommand } from '../src/dispatch.ts';
import { runGate } from '../src/gate.ts';
import { buildPayload, estimateTokens } from '../src/payload.ts';
import { converge, exportsName } from '../src/converge.ts';
import type { Spec, Task, Constitution } from '../src/schema.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'flaky');

const constitution: Constitution = { constitution: {
  name: 'N', version: 1, stack: ['node24'],
  articles: [{ id: 'ART-01', title: 'Errors are values', rule: 'Never throw across a boundary.', enforcement: 'lint' }],
  budgets: { max_attempts: 2, max_respec: 2, timeout_minutes: 1, max_payload_tokens: 4000 },
} };

const spec: Spec = {
  module: 'core/widget', runtime: 'esm',
  requirements: [{ id: 'REQ-01', ears: 'WHEN given items THE SYSTEM SHALL return their sum.', verified_by: ['SC-01'] }],
  types: 'type Items = number[];',
  contracts: { 'total(items: Items): number': { kind: 'query', precondition: 'items is finite', postcondition: 'returns the sum', errors: [] } },
  verification: { test_suite: 'test/widget.test.js', scenarios: [{ id: 'SC-01', given: 'three items', when: 'summed', then: 'the total is returned', test_name: 'sums every item' }] },
};

const task: Task['task'] = {
  target_module: 'core/widget',
  context: { constitution_articles: ['ART-01'], spec: 'core.widget.spec.yaml', upstream_exports: {} },
  deliverables: ['widget.js', 'test/widget.test.js'],
  execution_gate: { command: 'node --test test/widget.test.js', success_criteria: 'exit 0', timeout_minutes: 1 },
  budget: {},
};

const workspace = () => mkdtempSync(join(tmpdir(), 'aose-dispatch-'));

/* ---- payload ---- */

test('the payload carries only the target domain, its articles and its gate', () => {
  const payload = buildPayload({ domain: 'core/widget', attempt: 1, maxAttempts: 2, constitution, spec, task });
  assert.match(payload, /attempt 1 of 2/);
  assert.match(payload, /ART-01 Errors are values/);
  assert.match(payload, /node --test test\/widget\.test\.js/);
  assert.match(payload, /`widget\.js`/);
  assert.match(payload, /sums every item/, 'the scenario test name is handed to the worker verbatim');
  assert.ok(!payload.includes('Prior attempt notes'), 'a first attempt carries no prior notes');
  assert.ok(estimateTokens(payload) < 4000);
});

test('a retry payload carries the prior attempt notes forward', () => {
  const payload = buildPayload({ domain: 'core/widget', attempt: 2, maxAttempts: 2, constitution, spec, task, priorNotes: 'attempt 1 failed: expected 6, got 3' });
  assert.match(payload, /attempt 2 of 2/);
  assert.match(payload, /Prior attempt notes/);
  assert.match(payload, /expected 6, got 3/);
});

/* ---- cold workspace ---- */

test('a cold workspace contains only its seed, not the project', () => {
  const root = workspace();
  const wt = join(root, 'wt');
  const { seeded } = createWorkspace(wt, [
    { path: 'package.json', content: '{"type":"module"}' },
    { path: 'upstream.js', content: 'export const x = 1;' },
  ]);
  assert.deepEqual(seeded.sort(), ['package.json', 'upstream.js']);
  assert.ok(existsSync(join(wt, '.git')), 'the workspace is its own git repo so changes are attributable');
  assert.ok(!existsSync(join(wt, 'packages')), 'nothing from the harness repo leaks in');
});

/* ---- gate ---- */

test('the gate records the exit code and a hash of what it actually printed', async () => {
  const root = workspace();
  const pass = await runGate('node -e "console.log(\'ok\')"', root, { timeoutMinutes: 1, runDir: join(root, 'run') });
  assert.equal(pass.exit_code, 0);
  assert.equal(pass.stdout_sha256.length, 64);
  assert.match(readFileSync(pass.log_path, 'utf8'), /exit: 0/);

  const fail = await runGate('node -e "process.exit(3)"', root, { timeoutMinutes: 1 });
  assert.equal(fail.exit_code, 3);
});

/* ---- the attempt loop ---- */

test('a failing gate triggers a retry, and the second attempt passes', async () => {
  const ledger = new Ledger(':memory:');
  ledger.createProject('p');
  const root = workspace();

  const result = await dispatch(ledger, {
    slug: 'p', domain: 'core/widget', adapter: 'fake',
    workspaceRoot: root, repoRoot: root, spec, task, constitution,
    fixtureRoot: FIXTURES, timeoutMinutes: 1,
    seed: [{ path: 'package.json', content: '{"name":"w","private":true,"type":"module"}' }],
  });

  assert.equal(result.attempts.length, 2, 'attempt 1 must fail and attempt 2 must run');
  assert.notEqual(result.attempts[0].gate!.exit_code, 0);
  assert.match(result.attempts[0].gate!.stdout, /sums every item/,
    'the gate must actually run the tests; a nested runner that skips files and exits 0 is false evidence');
  assert.equal(result.attempts[1].gate!.exit_code, 0);
  assert.equal(result.passed, true);
  assert.equal(result.exhausted, false);

  const runs = ledger.runs('p', 'core/widget');
  assert.equal(runs.length, 2, 'both attempts are recorded as evidence');
  assert.equal(runs[1].gate_exit, 0);
  assert.equal(runs[1].gate_stdout_sha256.length, 64);

  const retryPayload = readFileSync(join(result.attempts[1].run_dir, 'payload.md'), 'utf8');
  assert.match(retryPayload, /Prior attempt notes/, 'the failure is fed back into the retry');
  assert.match(retryPayload, /attempt 2 of 2/);
});

test('the attempt bound stops the loop instead of retrying forever', async () => {
  const ledger = new Ledger(':memory:');
  ledger.createProject('p');
  const root = workspace();

  const result = await dispatch(ledger, {
    slug: 'p', domain: 'core/widget', adapter: 'fake',
    workspaceRoot: root, repoRoot: root, spec, task, constitution,
    fixtureRoot: join(FIXTURES, 'attempt-1'), maxAttempts: 2, timeoutMinutes: 1,
    seed: [{ path: 'package.json', content: '{"name":"w","private":true,"type":"module"}' }],
  });

  assert.equal(result.attempts.length, 2);
  assert.equal(result.passed, false);
  assert.equal(result.exhausted, true, 'an unfixable domain ends BLOCKED rather than looping');
});

test('a dry run builds the payload and the command line without spawning anything', async () => {
  const ledger = new Ledger(':memory:');
  ledger.createProject('p');
  const root = workspace();
  const result = await dispatch(ledger, {
    slug: 'p', domain: 'core/widget', adapter: 'claude',
    workspaceRoot: root, repoRoot: root, spec, task, constitution, dryRun: true,
  });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].gate, null);
  assert.equal(ledger.runs('p').length, 0, 'a dry run records no evidence because none was produced');
  assert.match(result.command_preview, /^claude -p --no-session-persistence --permission-mode acceptEdits/);
});

test('each adapter builds the documented headless invocation', () => {
  const preview = (name: string) => previewCommand(name, 'PAYLOAD', '/wt', '/run', { timeoutMinutes: 15 });
  assert.match(preview('claude'), /--output-format json --max-turns 40 --add-dir \/wt/);
  assert.match(preview('codex'), /codex exec -C \/wt --skip-git-repo-check --ephemeral --json/);
  assert.match(preview('codex'), /--sandbox workspace-write/);
  assert.match(previewCommand('codex', 'P', '/wt', '/run', { bypassSandbox: true }), /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(preview('agy'), /agy -p <payload> --mode accept-edits --output-format json --add-dir \/wt --print-timeout 15m/);
  assert.match(preview('gemini'), /gemini -p <payload> --approval-mode yolo -o json --include-directories \/wt/);
  assert.ok(!preview('gemini').includes('--sandbox'), 'gemini sandbox needs a container this host lacks');
});

/* ---- converge ---- */

test('exportsName finds each declaration form and rejects a miss', () => {
  const source = 'export function playMove(){}\nexport const LINES=[];\nexport { getBestMove };';
  for (const name of ['playMove', 'LINES', 'getBestMove']) assert.ok(exportsName(source, name), name);
  assert.equal(exportsName(source, 'missing'), false);
});

test('converge scores a clean run at full marks and a hollow one below threshold', () => {
  const root = workspace();
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'widget.js'), 'export function total(i){return i.reduce((a,b)=>a+b,0);}');
  writeFileSync(join(root, 'test', 'widget.test.js'), "test('sums every item', () => {});");

  const good = converge({
    domain: 'core/widget', worktree: root, spec, task,
    gateExit: 0, gateStdout: 'ok 1 - sums every item', gateStdoutSha: 'a'.repeat(64),
    sources: [], citedUrls: [], approvalAt: '2026-01-01', firstDispatchAt: '2026-01-02',
  });
  assert.equal(good.passed, true);
  for (const pillar of good.pillars) assert.equal(pillar.score, 100, pillar.name);

  const hollow = converge({
    domain: 'core/widget', worktree: mkdtempSync(join(tmpdir(), 'aose-empty-')), spec, task,
    gateExit: 1, gateStdout: '', gateStdoutSha: '',
    sources: [], citedUrls: ['https://arxiv.org/abs/1'], approvalAt: null, firstDispatchAt: '2026-01-02',
  });
  assert.equal(hollow.passed, false);
  const byName = Object.fromEntries(hollow.pillars.map((p) => [p.name, p.score]));
  assert.equal(byName['Spec compliance'], 0, 'no deliverables means no compliance');
  assert.equal(byName['Test adequacy'], 0, 'a failing gate cannot score');
  assert.ok(byName['Risk & evidence'] < 70, 'an unverified citation and no approval must not pass');
});

test('converge penalizes edits outside the declared deliverables', () => {
  const root = workspace();
  createWorkspace(root, [{ path: 'package.json', content: '{}' }]);
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'widget.js'), 'export function total(i){return 0;}');
  writeFileSync(join(root, 'test', 'widget.test.js'), "test('sums every item', () => {});");
  writeFileSync(join(root, 'sneaky.js'), 'export const surprise = 1;');

  const report = converge({
    domain: 'core/widget', worktree: root, spec, task,
    gateExit: 0, gateStdout: 'sums every item', gateStdoutSha: 'b'.repeat(64),
    sources: [], citedUrls: [], approvalAt: '2026-01-01', firstDispatchAt: '2026-01-02',
  });
  const quality = report.pillars.find((p) => p.name === 'Code quality')!;
  assert.ok(quality.score < 100, 'an out-of-scope file must cost the run');
  assert.match(quality.components[0].detail, /sneaky\.js/);
});
