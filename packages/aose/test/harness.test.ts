import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { Harness } from '../src/harness.ts';
import { Ledger } from '../src/ledger.ts';
import { renderMarkdown, buildBlueprint } from '../src/export.ts';
import type { FetchLike } from '../src/research.ts';

const SOURCE_TICTACTOE = resolve(import.meta.dirname, '..', '..', '..', 'blueprints', 'tictactoe');

/** A project rooted in a temp dir with the tictactoe blueprint copied in. */
function project(): { harness: Harness; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'aose-harness-'));
  mkdirSync(join(root, 'blueprints'), { recursive: true });
  cpSync(SOURCE_TICTACTOE, join(root, 'blueprints', 'tictactoe'), { recursive: true });
  const harness = new Harness(root, new Ledger(':memory:'));
  return { harness, root };
}

const nl2contract = () => YAML.parse(readFileSync(join(SOURCE_TICTACTOE, 'sources', 'nl2contract.yaml'), 'utf8'));

const verifiedFetch: FetchLike = async (url: string) => ({
  ok: true, status: 200,
  text: async () => url.includes('arxiv')
    ? '<feed><entry><title>Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?</title></entry></feed>'
    : '{"full_name":"x/y"}',
});

const mismatchFetch: FetchLike = async () => ({
  ok: true, status: 200,
  text: async () => '<feed><entry><title>AgriGov: A Structured Multilingual Dataset Curation for Indian Government Schemes for Farmers</title></entry></feed>',
});

test('an unverified source blocks review, and verifying it unblocks review', async () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.addSource('tictactoe', nl2contract());
  assert.equal(harness.compile('tictactoe').ok, true);

  const blocked = harness.review('tictactoe');
  assert.equal(blocked.passed, false);
  assert.ok(blocked.findings.some((f) => f.id === 'LINT-17'), 'a recorded but unchecked source is not evidence');

  await harness.verifySources('tictactoe', verifiedFetch);
  assert.equal(harness.lint('tictactoe').ok, true);
  assert.equal(harness.review('tictactoe').passed, true);
});

test('a source whose title does not match its citation blocks review permanently', async () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.addSource('tictactoe', nl2contract());
  harness.compile('tictactoe');
  await harness.verifySources('tictactoe', mismatchFetch);

  const review = harness.review('tictactoe');
  assert.equal(review.passed, false);
  assert.ok(review.findings.some((f) => f.id === 'LINT-17' && /did not match/.test(f.message)));
  assert.throws(() => { throw new Error(harness.approve('tictactoe', 'owner').passed ? 'approved' : 'blocked'); }, /blocked/);
});

test('dispatch is refused without an approval and after the blueprint changes', async () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.addSource('tictactoe', nl2contract());
  harness.compile('tictactoe');
  await harness.verifySources('tictactoe', verifiedFetch);
  harness.lint('tictactoe');
  harness.review('tictactoe');

  await assert.rejects(() => harness.dispatch('tictactoe', { adapter: 'fake' }), /requires an approved blueprint/);

  harness.approve('tictactoe', 'owner');
  assert.ok(harness.ledger.activeApproval('tictactoe'), 'approval is recorded');

  harness.compile('tictactoe');                      // the blueprint changes again
  assert.equal(harness.ledger.activeApproval('tictactoe'), undefined,
    'recompiling supersedes the approval rather than letting it silently stand');
  await assert.rejects(() => harness.dispatch('tictactoe', { adapter: 'fake' }), /approved blueprint|active approval/);
});

test('a dry run needs no approval and spawns nothing', async () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.compile('tictactoe');
  const results = await harness.dispatch('tictactoe', { adapter: 'codex', dryRun: true });
  assert.equal(results.length, 2);
  assert.match(results[0].command_preview, /codex exec/);
  assert.equal(harness.ledger.runs('tictactoe').length, 0);
});

test('a domain cannot be dispatched before the domain it depends on has passed', async () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.addSource('tictactoe', nl2contract());
  harness.compile('tictactoe');
  await harness.verifySources('tictactoe', verifiedFetch);
  harness.lint('tictactoe');
  harness.review('tictactoe');
  harness.approve('tictactoe', 'owner');

  await assert.rejects(
    () => harness.dispatch('tictactoe', { domain: 'ui/client', adapter: 'fake' }),
    /depends on "core\/engine", which has not passed its gate/,
  );
});

test('the exported plan carries the contracts, traceability and citation status the v1 export lacked', () => {
  const dir = SOURCE_TICTACTOE;
  const { input } = (() => {
    const { harness } = project();
    harness.init('tictactoe');
    harness.capture('tictactoe');
    return { input: harness.artifacts('tictactoe') };
  })();

  const blueprint = buildBlueprint({
    slug: 'tictactoe',
    constitution: input.constitution!, idea: input.idea!, manifest: input.manifest!,
    specs: input.specs!, tasks: input.tasks!,
    sources: [{ url: 'https://arxiv.org/abs/2510.12702', kind: 'arxiv', title: 'T', claim: 'C', confidence: 'medium',
      supports: ['DEC-02'], verified: { status: 'verified', fetched_title: 'T', checked_at: 'now', detail: 'ok' } }],
    topoOrder: ['core/engine', 'ui/client'],
  });
  const markdown = renderMarkdown(blueprint);

  assert.match(markdown, /aose-blueprint\/v2/);
  assert.match(markdown, /Build order \(dependencies first\): `core\/engine` → `ui\/client`/);
  assert.match(markdown, /ART-01/, 'the constitution travels with the plan');
  assert.match(markdown, /REQ-01/);
  assert.match(markdown, /SC-01/);
  assert.match(markdown, /playMove\(state: State, index: number\): State \| Error/, 'contracts are reproduced verbatim');
  assert.match(markdown, /pre: /);
  assert.match(markdown, /post: /);
  assert.match(markdown, /immutably updates board and alternates turn/, 'the exact test name a worker must use');
  assert.match(markdown, /\| verified \|/, 'every citation shows whether it was checked');
  assert.ok(markdown.length > 4000, 'the v2 plan is a dispatchable contract, not a summary');
});

test('validate replays the transition log and refuses a tampered state', () => {
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  assert.equal(harness.validate('tictactoe').replay_ok, true);

  harness.ledger.setState('tictactoe', 'EXPORTED');
  const report = harness.validate('tictactoe');
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((e) => /not reachable by replaying/.test(e)));
});
