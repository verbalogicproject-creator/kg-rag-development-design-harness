import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConstitutionSchema, IdeaSchema, SourceSchema, SpecSchema, TaskSchema,
  ManifestSchema, safeParse, EARS_PATTERN,
} from '../src/schema.ts';

const article = { id: 'ART-01', title: 'T', rule: 'R', enforcement: 'lint' };

test('EARS pattern accepts the four trigger forms and rejects prose', () => {
  for (const good of [
    'WHEN a cell is occupied THE SYSTEM SHALL reject the move.',
    'WHILE the AI is active THE SYSTEM SHALL never lose.',
    'IF input is empty THE SYSTEM SHALL return an error.',
    'WHERE dark mode is enabled THE SYSTEM SHALL invert the surface.',
    'THE SYSTEM SHALL persist every change.',
  ]) assert.ok(EARS_PATTERN.test(good), good);

  for (const bad of ['the system should reject bad moves', 'Rejects occupied cells', 'WHEN a cell is occupied, reject it.']) {
    assert.ok(!EARS_PATTERN.test(bad), bad);
  }
});

test('constitution requires at least one article and defaults its budgets', () => {
  const ok = safeParse(ConstitutionSchema, { constitution: { name: 'N', version: 1, stack: ['node24'], articles: [article] } });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal((ok.value as { constitution: { budgets: { max_attempts: number } } }).constitution.budgets.max_attempts, 2);

  const noArticles = safeParse(ConstitutionSchema, { constitution: { name: 'N', version: 1, stack: ['node24'], articles: [] } });
  assert.equal(noArticles.ok, false);
});

test('article ids must be ART-nn', () => {
  const bad = safeParse(ConstitutionSchema, { constitution: { name: 'N', version: 1, stack: ['x'], articles: [{ ...article, id: 'A1' }] } });
  assert.equal(bad.ok, false);
});

test('idea rejects success criteria that are not EARS', () => {
  const base = { title: 'T', goal: 'G', audience: 'A', seed_author: 'human', scope_class: 'bounded' };
  assert.equal(safeParse(IdeaSchema, { idea: { ...base, success_criteria: ['WHEN x happens THE SYSTEM SHALL do y.'] } }).ok, true);
  assert.equal(safeParse(IdeaSchema, { idea: { ...base, success_criteria: ['it should work nicely'] } }).ok, false);
});

test('a source must use https and defaults to unverified', () => {
  const ok = safeParse(SourceSchema, {
    url: 'https://arxiv.org/abs/2510.12702', kind: 'arxiv', title: 'T', claim: 'C', confidence: 'medium',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal((ok.value as { verified: { status: string } }).verified.status, 'unverified');

  assert.equal(safeParse(SourceSchema, {
    url: 'http://example.com/x', kind: 'web', title: 'T', claim: 'C', confidence: 'low',
  }).ok, false);
});

test('a contract must declare both a precondition and a postcondition', () => {
  const spec = (contract: unknown) => ({
    module: 'core/x', runtime: 'esm',
    requirements: [{ id: 'REQ-01', ears: 'THE SYSTEM SHALL work.', verified_by: ['SC-01'] }],
    types: 'type T = number;',
    contracts: { 'f(a: T): T': contract },
    verification: { test_suite: 't.js', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'n' }] },
  });
  assert.equal(safeParse(SpecSchema, spec({ kind: 'query', precondition: 'p', postcondition: 'q' })).ok, true);
  assert.equal(safeParse(SpecSchema, spec({ kind: 'query', precondition: 'p' })).ok, false);
  assert.equal(safeParse(SpecSchema, spec({ kind: 'query', postcondition: 'q' })).ok, false);
});

test('a task must carry an execution gate with a command', () => {
  const task = (gate: unknown) => ({
    task: { target_module: 'core/x', context: { spec: 's.yaml' }, deliverables: ['a.js'], execution_gate: gate },
  });
  assert.equal(safeParse(TaskSchema, task({ command: 'node --test', success_criteria: 'exit 0' })).ok, true);
  assert.equal(safeParse(TaskSchema, task({ success_criteria: 'exit 0' })).ok, false);
});

test('domain names must be lowercase path segments', () => {
  const manifest = (domain: string) => ({
    system: { name: 'N', constitution: 'c.yaml', scope_class: 'bounded', boundaries: [{ domain, responsibility: 'R', exports: ['a'], spec: 's.yaml', task: 't.yaml' }] },
    invariants: ['ART-01'],
  });
  assert.equal(safeParse(ManifestSchema, manifest('core/engine')).ok, true);
  assert.equal(safeParse(ManifestSchema, manifest('Core/Engine')).ok, false);
});
