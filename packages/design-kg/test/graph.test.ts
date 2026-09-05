/**
 * The design graph.
 *
 * These defend the properties that make a graph worth reasoning from: it
 * refuses rather than invents, its composite rules fire on the bundle and not
 * on a member, and a decision a person made outranks a rule someone wrote down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, collect, checksum, RELATIONS } from '../src/build.ts';
import { DesignGraph } from '../src/query.ts';

const CURATED = 'packages/design-kg/curated';
const DB = 'packages/design-kg/ls-design.db';

/* ---- the build refuses what would make edges untrustworthy ---- */

function curated(nodes: string, edges: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-'));
  mkdirSync(join(dir, 'curated'), { recursive: true });
  writeFileSync(join(dir, 'curated', 'nodes.yaml'), nodes);
  writeFileSync(join(dir, 'curated', 'edges.yaml'), edges);
  return join(dir, 'curated');
}

test('no source, no node', () => {
  const dir = curated(
    'primitive:\n  - id: p_a\n    name: A\n  - id: p_b\n    name: B\n    evidence: { source: x.md }\n',
    'conflicts_with:\n  - { source: p_a, target: p_b }\n',
  );
  assert.ok(collect(dir).problems.some((p) => /p_a: no evidence.source/.test(p)));
});

test('the edge vocabulary is closed, and a seventh relation fails the build', () => {
  assert.equal(RELATIONS.length, 6);
  const dir = curated(
    'primitive:\n  - { id: p_a, name: A, evidence: { source: x.md } }\n  - { id: p_b, name: B, evidence: { source: x.md } }\n',
    'conflicts_with:\n  - { source: p_a, target: p_b }\ninspired_by:\n  - { source: p_a, target: p_b }\n',
  );
  const problems = collect(dir).problems;
  assert.ok(problems.some((p) => /"inspired_by" is not one of the six/.test(p)),
    'a vocabulary that grows one session at a time decays into synonyms');
});

test('an edge to a node that does not exist fails the build', () => {
  const dir = curated(
    'primitive:\n  - { id: p_a, name: A, evidence: { source: x.md } }\n',
    'conflicts_with:\n  - { source: p_a, target: p_ghost }\n',
  );
  assert.ok(collect(dir).problems.some((p) => /target "p_ghost" is not a declared node/.test(p)));
});

test('a node nothing links to fails the build', () => {
  // Corpus, not graph: no traversal can reach it, so it answers no question.
  const dir = curated(
    'primitive:\n  - { id: p_a, name: A, evidence: { source: x.md } }\n'
    + '  - { id: p_b, name: B, evidence: { source: x.md } }\n'
    + '  - { id: p_lonely, name: Lonely, evidence: { source: x.md } }\n',
    'conflicts_with:\n  - { source: p_a, target: p_b }\n',
  );
  assert.ok(collect(dir).problems.some((p) => /p_lonely: degree zero/.test(p)));
});

/* ---- reproducibility ---- */

test('the same curated input yields the same checksum', () => {
  const a = collect(CURATED);
  const b = collect(CURATED);
  assert.equal(a.checksum, b.checksum);
  assert.match(a.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(checksum(a.nodes, a.edges), a.checksum);
});

test('the shipped graph builds clean', () => {
  const result = build(CURATED, join(mkdtempSync(join(tmpdir(), 'dkg-build-')), 'g.db'));
  assert.deepEqual(result.problems, []);
  assert.ok(result.nodes.length >= 60, `expected a real batch, got ${result.nodes.length} nodes`);
  assert.ok(result.edges.length >= 50, `expected a connected graph, got ${result.edges.length} edges`);
});

/* ---- the questions ---- */

test('it answers the question that was answered by invention', () => {
  // Four families were invented on the spot while five sat in the corpus one
  // link away. This is that question, asked of the graph instead.
  const graph = new DesignGraph(DB);
  const answer = graph.directionsFor([
    'cond_audience_solo_operator', 'cond_content_tabular_numeric', 'cond_platform_offline_local',
  ]);

  assert.equal(answer.status, 'answer');
  assert.equal(answer.items[0].direction.id, 'dir_precise_technical');
  assert.equal(answer.items[0].covers.length, 3);
  assert.ok(answer.support.every((s) => s.source.length > 0), 'every answer cites its source');
  graph.close();
});

test('a decision a person made outranks a rule someone wrote down', () => {
  const graph = new DesignGraph(DB);
  const answer = graph.directionsFor(['cond_audience_solo_operator']);
  assert.equal(answer.items[0].chosen, true, 'the chosen edge is marked as such');
  assert.match(
    answer.support.find((s) => /user decision/.test(s.source))!.source,
    /design.system.yaml/,
    'and it cites the artifact the person decided in',
  );
  graph.close();
});

test('it refuses an unknown condition and says what it does know', () => {
  // The property that makes a graph safe to reason from: an answer it cannot
  // support is withheld, and the refusal is actionable rather than a dead end.
  const graph = new DesignGraph(DB);
  const answer = graph.directionsFor(['cond_entirely_invented']);
  assert.equal(answer.status, 'refused');
  assert.equal(answer.reason, 'unknown_node');
  assert.deepEqual(answer.items, []);
  assert.ok((answer.known ?? []).includes('cond_audience_solo_operator'));
  graph.close();
});

test('choosing a direction surfaces what it requires and what it warns about', () => {
  const graph = new DesignGraph(DB);
  const answer = graph.commitments('dir_precise_technical');
  assert.equal(answer.status, 'answer');
  const warned = answer.items.filter((item) => item.relation === 'warns_about').map((i) => i.node.id);
  assert.ok(warned.includes('anti_terminal_cliche'),
    'the family cautions against terminal clichés, so choosing it must surface that');
  assert.ok(answer.items.some((item) => item.relation === 'requires'));
  graph.close();
});

/* ---- the composite ---- */

test('the convergence composite fires on the bundle that started this work', () => {
  const graph = new DesignGraph(DB);
  const hit = graph.compositeHits(['#f7f5f1', 'Fraunces', '#d97757', '#1a1714'])
    .find((h) => h.antipattern.id === 'anti_convergence_bundle')!;

  assert.equal(hit.fires, true);
  assert.equal(hit.threshold, 3);
  assert.equal(hit.matched.length, 4);
  graph.close();
});

test('one member of the composite is legitimate and does not fire', () => {
  // The source rule is explicit: a brief naming any of these wins outright.
  // A pairwise model cannot express this; the threshold is the whole point.
  const graph = new DesignGraph(DB);
  for (const alone of [['Fraunces'], ['#d97757'], ['#f7f5f1', 'Fraunces']]) {
    const hit = graph.compositeHits(alone).find((h) => h.antipattern.id === 'anti_convergence_bundle')!;
    assert.equal(hit.fires, false, `${alone.join(' + ')} must not fire below the threshold`);
  }
  graph.close();
});

test('a composite rule can never demand more members than it has', () => {
  // A threshold above the component count reads as a guard and is unreachable.
  const graph = new DesignGraph(DB);
  for (const hit of graph.compositeHits([])) {
    const members = graph.neighbours(hit.antipattern.id, 'component_of', 'in').length;
    assert.ok(hit.threshold <= members,
      `${hit.antipattern.id} needs ${hit.threshold} of ${members} — unreachable`);
  }
  graph.close();
});

test('conflicts traverse in both directions', () => {
  const graph = new DesignGraph(DB);
  const answer = graph.conflicts('anti_mono_as_costume');
  assert.equal(answer.status, 'answer', 'the target end of an edge must find its source');
  assert.ok(answer.items.some((n) => n.id === 'prim_mono_for_numerics'));
  graph.close();
});
