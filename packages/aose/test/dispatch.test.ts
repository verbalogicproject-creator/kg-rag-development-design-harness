import test from 'node:test';
import { undeclaredHosts } from '../src/lint.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { dispatch, createWorkspace, previewCommand, workerTimeout, gateTimeout, workerTurns } from '../src/dispatch.ts';
import { runGate } from '../src/gate.ts';
import { buildPayload, estimateTokens } from '../src/payload.ts';
import { converge, exportsName, PLACEHOLDER, NOT_AUTHORED } from '../src/converge.ts';
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
    sources: [], citedUrls: [], approvalAt: '2026-01-01', dispatchedAt: '2026-01-02',
  });
  assert.equal(good.passed, true);
  for (const pillar of good.pillars) assert.equal(pillar.score, 100, pillar.name);

  const hollow = converge({
    domain: 'core/widget', worktree: mkdtempSync(join(tmpdir(), 'aose-empty-')), spec, task,
    gateExit: 1, gateStdout: '', gateStdoutSha: '',
    sources: [], citedUrls: ['https://arxiv.org/abs/1'], approvalAt: null, dispatchedAt: '2026-01-02',
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
    sources: [], citedUrls: [], approvalAt: '2026-01-01', dispatchedAt: '2026-01-02',
  });
  const quality = report.pillars.find((p) => p.name === 'Code quality')!;
  assert.ok(quality.score < 100, 'an out-of-scope file must cost the run');
  assert.match(quality.components[0].detail, /sneaky\.js/);
});

/* ---- converge must measure the worker, not the harness's own side effects ---- */

test('a reserved test host is not an allowlist violation', () => {
  // https://example.test/jobs/42 appeared in a test fixture and was reported
  // as reaching an undeclared host. RFC 2606 and RFC 6761 reserve these names
  // so they can never resolve, and ART-06 is about what a domain can actually
  // reach — an unroutable name reaches nothing.
  for (const host of ['example.test', 'foo.example', 'thing.invalid', 'example.com', 'api.local']) {
    assert.deepEqual(undeclaredHosts(`fetch('https://${host}/x')`, []), [],
      `${host} is reserved and cannot be reached`);
  }
  // A real host is still caught, or the check would guard nothing.
  assert.deepEqual(undeclaredHosts("fetch('https://upwork.com/jobs')", []), ['upwork.com']);
  assert.deepEqual(undeclaredHosts("fetch('https://remoteok.com/api')", ['https://remoteok.com/api']), []);
});

test('the placeholder check does not fire on correct code', () => {
  // Both of these were scored as unfinished work in the real build. The first
  // is the HTML input attribute; the second is a worker's comment explaining
  // how it COMPLIED with the rule against inventing content.
  assert.equal(PLACEHOLDER.test('<input placeholder={copy.skillsHelp} />'), false);
  assert.equal(PLACEHOLDER.test(' * no component can quietly invent placeholder content — ART-08'), false);
  // The markers that actually mean unfinished work still fire.
  for (const marker of ['// TODO: wire this up', '/* FIXME */', 'throw new Error("not implemented")', '// XXX', '// HACK']) {
    assert.equal(PLACEHOLDER.test(marker), true, marker);
  }
});

test('gate side effects are not counted against the worker', () => {
  // ui/client's gate is `npm install && npm run build`, so node_modules/,
  // dist/ and a lockfile exist because the HARNESS ran that command. The
  // worker scored 0/50 for "changes stay inside deliverables" because of it,
  // and every other domain lost 10 points to an unrelated tool's .vouch/ logs.
  for (const path of [
    'node_modules/.bin/x', 'dist/assets/index-abc.js', 'dist/index.html',
    'build/main.js', 'coverage/lcov.info', 'out/x.js',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.vouch/reads-abc.json', 'src/.cache/x', '.next/build',
  ]) {
    assert.equal(NOT_AUTHORED.test(path), true, `${path} is not authored by the worker`);
  }
  // Real work, including files that merely live near those names, still counts.
  for (const path of [
    'src/App.tsx', 'src/components/PipelineBoard.tsx', 'package.json',
    'src/distance.ts', 'src/outbox.ts', 'test/build-helpers.js',
  ]) {
    assert.equal(NOT_AUTHORED.test(path), false, `${path} is the worker's own output`);
  }
});

/* ---- a domain declares what it costs, instead of it living in a shell history ---- */

test('a task declares its own worker budget, and the gate keeps its own clock', () => {
  /* ui/client needed 120 turns and 40 minutes and could only be told so on the
   * command line, so it timed out twice at the 15-minute default having written
   * nothing — and would again for anyone re-running `aose dispatch` without
   * knowing. The two clocks stay separate on purpose: a gate that runs
   * `npm install && vite build && vitest` needs a few minutes, and inheriting a
   * 40-minute worker budget would let a hung gate sit there for 40 minutes. */
  const task = {
    target_module: 'ui/client',
    context: { constitution_articles: [], spec: 's.yaml', upstream_exports: {} },
    deliverables: ['src/App.tsx'],
    execution_gate: { command: 'npm test', success_criteria: 'exit 0', timeout_minutes: 15 },
    budget: { max_attempts: 2, max_turns: 120, timeout_minutes: 40 },
  } as unknown as Task;

  assert.equal(workerTimeout(task, undefined), 40, 'the worker uses its declared budget');
  assert.equal(gateTimeout(task), 15, 'the gate keeps the timeout it declares');
  assert.equal(workerTimeout(task, 5), 5, 'an explicit flag still wins');

  // Undeclared falls back to the gate's timeout, which is what it did before,
  // so an existing blueprint behaves exactly as it always has.
  const plain = { ...task, budget: { max_attempts: 2 } } as unknown as Task;
  assert.equal(workerTimeout(plain, undefined), 15);
  assert.equal(workerTurns(plain), undefined, 'no turn budget declared, no override');
  assert.equal(workerTurns(task), 120);
});
