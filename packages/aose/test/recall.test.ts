/**
 * The remember plane, read side.
 *
 * The property under test is restraint. Recall must be silent when it knows
 * nothing, must join on declared constraint ids rather than guess relevance,
 * and must stay small enough that carrying it costs less than the retry it
 * prevents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { recall } from '../src/recall.ts';

const ledger = (): Ledger => new Ledger(join(mkdtempSync(join(tmpdir(), 'aose-recall-')), 'w.sqlite'));

/** A failing run of `domain`, held to `constraints`, with a one-line cause. */
function failed(l: Ledger, slug: string, domain: string, adapter: string, constraints: string[], note: string): void {
  l.createProject(slug);
  const id = l.startRun(slug, domain, adapter, 1, '/tmp/x', constraints);
  l.finishRun(id, { gate_exit: 1, notes: note });
}

test('a cold ledger recalls nothing and says so', () => {
  // The common case, and the one most easily faked. An empty recall that says
  // it is empty beats a populated one that guessed.
  const l = ledger();
  const result = recall(l, 'anything', 'core/match', ['ART-01', 'SC-01']);
  assert.equal(result.from_runs, 0);
  assert.deepEqual(result.known_failures, []);
  assert.equal(result.text, '', 'nothing to carry means nothing added to the payload');
  l.close();
});

test('it joins on declared constraints, not on the project', () => {
  // A failure under the same constraint is relevant wherever it happened. That
  // is the whole reason for joining on the constraint rather than the slug.
  const l = ledger();
  failed(l, 'some-other-project', 'core/match', 'codex', ['SC-03'], 'returned a bare number where SC-03 wants reasons');
  const result = recall(l, 'a-brand-new-project', 'core/match', ['SC-03']);
  assert.equal(result.known_failures.length, 1);
  assert.deepEqual(result.shared_constraints, ['SC-03']);
  l.close();
});

test('it stays silent when nothing shares a constraint', () => {
  // No fuzzy fallback, no "close enough". Two independent projects measured
  // that no score threshold separates fluent-irrelevant input from signal; a
  // join has no threshold to be wrong about.
  const l = ledger();
  failed(l, 'p', 'core/match', 'claude', ['SC-03'], 'a real failure, under a constraint this task does not declare');
  const result = recall(l, 'p', 'core/match', ['SC-99']);
  assert.deepEqual(result.known_failures, []);
  assert.equal(result.text, '');
  l.close();
});

test('a different domain is never recalled, however similar the constraints', () => {
  const l = ledger();
  failed(l, 'p', 'core/parse', 'claude', ['SC-03'], 'parse failure');
  assert.deepEqual(recall(l, 'p', 'core/match', ['SC-03']).known_failures, []);
  l.close();
});

test('a passing run is not a failure to avoid', () => {
  const l = ledger();
  l.createProject('p');
  const id = l.startRun('p', 'core/match', 'claude', 1, '/tmp/x', ['SC-03']);
  l.finishRun(id, { gate_exit: 0, notes: 'all scenarios named and passing' });
  assert.deepEqual(recall(l, 'p', 'core/match', ['SC-03']).known_failures, []);
  l.close();
});

test('one cause under several constraints is reported once, not once per constraint', () => {
  // Payload economy. The same sentence printed three times spends budget to say
  // nothing new, and the budget is what LINT-24 enforces.
  const l = ledger();
  failed(l, 'p', 'core/match', 'claude', ['ART-02', 'SC-03', 'SC-04'], 'scoreOpportunity returned a bare number');
  const result = recall(l, 'p', 'core/match', ['ART-02', 'SC-03', 'SC-04']);

  assert.equal(result.known_failures.length, 1);
  assert.deepEqual(result.known_failures[0].constraints, ['ART-02', 'SC-03', 'SC-04']);
  assert.equal((result.text.match(/scoreOpportunity/g) ?? []).length, 1);
  l.close();
});

test('a repeated failure is counted, because four sightings is not an anecdote', () => {
  const l = ledger();
  for (const adapter of ['claude', 'codex', 'agy']) {
    failed(l, `p-${adapter}`, 'core/match', adapter, ['SC-03'], 'returned a bare number where SC-03 wants reasons');
  }
  const result = recall(l, 'new', 'core/match', ['SC-03']);
  assert.equal(result.known_failures[0].seen_in, 3, 'three adapters hitting one cause is the strongest signal available');
  l.close();
});

test('a later passing run supplies the resolution', () => {
  const l = ledger();
  failed(l, 'p', 'core/match', 'claude', ['SC-03'], 'returned a bare number');
  const fix = l.startRun('p', 'core/match', 'claude', 2, '/tmp/y', ['SC-03']);
  l.finishRun(fix, { gate_exit: 0, notes: 'returned Score with reasons[]' });

  const result = recall(l, 'p', 'core/match', ['SC-03']);
  assert.match(result.known_failures[0].resolved_by, /Score with reasons/);
  assert.match(result.text, /resolved by:/);
  l.close();
});

test('the recalled section stays within its budget', () => {
  // Recall must cost less than the retry it prevents, or it is not worth
  // carrying. It truncates rather than growing without bound.
  const l = ledger();
  for (let i = 0; i < 40; i += 1) {
    failed(l, `p${i}`, 'core/match', 'claude', ['SC-03'], `distinct failure number ${i} `.repeat(6));
  }
  const result = recall(l, 'new', 'core/match', ['SC-03'], { maxChars: 600 });
  assert.ok(result.text.length <= 602, `expected a bounded section, got ${result.text.length} chars`);
  assert.ok(result.known_failures.length <= 6, 'and a bounded number of failures');
  l.close();
});

test('a run records the constraints it was held to', () => {
  // Without this there is nothing to join on, and recall would have to infer
  // relevance from the blueprint — which can change after the run cannot.
  const l = ledger();
  l.createProject('p');
  const id = l.startRun('p', 'core/match', 'claude', 1, '/tmp/x', ['SC-03', 'ART-02']);
  l.finishRun(id, { gate_exit: 1, notes: 'x' });
  const row = l.allRuns().find((r) => r.id === id)!;
  assert.deepEqual(JSON.parse(row.constraints), ['ART-02', 'SC-03'], 'sorted, so the record is stable');
  l.close();
});
