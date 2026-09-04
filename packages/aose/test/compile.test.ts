import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { compile, expandFlat, readTopoOrder } from '../src/compile.ts';
import type { FlatBlueprint } from '../src/schema.ts';

const flat: FlatBlueprint = {
  meta: { name: 'Tiny', module: 'core/main', runtime: ['node24', 'esm'], entry: 'index.js' },
  files: { 'index.js': 'the module', 'test/index.test.js': 'the tests' },
  types: 'type R = { ok: true; value: number } | { ok: false; error: string };',
  contracts: { 'run(n: number): R': { kind: 'transition', precondition: 'n >= 0', postcondition: 'returns a result', errors: [] } },
  requirements: [{ id: 'REQ-01', ears: 'THE SYSTEM SHALL run.', verified_by: ['SC-01'] }],
  verification: { test_suite: 'test/index.test.js', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'runs' }] },
  execution_gate: { command: 'node --test', success_criteria: 'exit 0' },
};

test('the flat five-plane format expands into a one-boundary triad', () => {
  const { manifest, spec, task } = expandFlat(flat, 'constitution.yaml', ['ART-01']);
  assert.equal(manifest.system.boundaries.length, 1);
  assert.equal(manifest.system.boundaries[0].domain, 'core/main');
  assert.deepEqual(manifest.system.boundaries[0].exports, ['run'], 'exports are derived from the contract names');
  assert.equal(spec.module, 'core/main');
  assert.deepEqual(task.task.deliverables, ['index.js', 'test/index.test.js'], 'deliverables come from the files map');
  assert.equal(task.task.execution_gate.command, 'node --test');
});

test('compile expands a flat blueprint on disk and then normalizes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-flat-'));
  writeFileSync(join(dir, 'blueprint.flat.yaml'), YAML.stringify(flat));
  const result = compile(dir);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.expanded_from_flat, true);
  assert.deepEqual(result.topo_order, ['core/main']);
  assert.match(readFileSync(join(dir, 'system.manifest.yaml'), 'utf8'), /expanded from blueprint.flat.yaml/);
});

test('compile derives upstream exports from the DAG rather than trusting the task file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-triad-'));
  const manifest = {
    system: { name: 'N', constitution: 'constitution.yaml', scope_class: 'bounded', boundaries: [
      { domain: 'core/a', responsibility: 'A', depends_on: [], exports: ['alpha', 'beta'], spec: 'a.spec.yaml', task: 'a.task.yaml' },
      { domain: 'ui/b', responsibility: 'B', depends_on: ['core/a'], exports: ['render'], spec: 'b.spec.yaml', task: 'b.task.yaml' },
    ] },
    invariants: ['ART-01'], decisions: [],
  };
  const spec = (module: string) => ({
    module, runtime: 'esm',
    requirements: [{ id: 'REQ-01', ears: 'THE SYSTEM SHALL work.', verified_by: ['SC-01'] }],
    types: 'type R = { ok: true } | { ok: false };',
    contracts: { 'go(): R': { kind: 'transition', precondition: 'p', postcondition: 'q', errors: [] } },
    verification: { test_suite: 't.js', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'n' }] },
  });
  const task = (module: string, spec: string) => ({
    task: { target_module: module, context: { constitution_articles: [], spec, upstream_exports: { 'core/a': ['WRONG'] } },
      deliverables: ['x.js'], execution_gate: { command: 'node --test', success_criteria: 'exit 0' }, budget: {} },
  });
  writeFileSync(join(dir, 'system.manifest.yaml'), YAML.stringify(manifest));
  writeFileSync(join(dir, 'a.spec.yaml'), YAML.stringify(spec('core/a')));
  writeFileSync(join(dir, 'b.spec.yaml'), YAML.stringify(spec('ui/b')));
  writeFileSync(join(dir, 'a.task.yaml'), YAML.stringify(task('core/a', 'a.spec.yaml')));
  writeFileSync(join(dir, 'b.task.yaml'), YAML.stringify(task('ui/b', 'b.spec.yaml')));

  const result = compile(dir);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.topo_order, ['core/a', 'ui/b']);
  assert.deepEqual(readTopoOrder(dir), ['core/a', 'ui/b']);

  const rewritten = YAML.parse(readFileSync(join(dir, 'b.task.yaml'), 'utf8'));
  assert.deepEqual(rewritten.task.context.upstream_exports, { 'core/a': ['alpha', 'beta'] },
    'the hand-written WRONG entry is replaced by what the boundary actually exports');
  const root = YAML.parse(readFileSync(join(dir, 'a.task.yaml'), 'utf8'));
  assert.deepEqual(root.task.context.upstream_exports, {}, 'a root domain gets nothing');
});

test('compile refuses a cyclic architecture instead of emitting a build order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aose-cycle-'));
  writeFileSync(join(dir, 'system.manifest.yaml'), YAML.stringify({
    system: { name: 'N', constitution: 'c.yaml', scope_class: 'bounded', boundaries: [
      { domain: 'a', responsibility: 'A', depends_on: ['b'], exports: ['x'], spec: 'a.spec.yaml', task: 'a.task.yaml' },
      { domain: 'b', responsibility: 'B', depends_on: ['a'], exports: ['y'], spec: 'b.spec.yaml', task: 'b.task.yaml' },
    ] }, invariants: ['ART-01'], decisions: [],
  }));
  const result = compile(dir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /cyclic/i);
});
