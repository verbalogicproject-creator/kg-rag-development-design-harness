import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { Harness, matchBlocked } from '../src/harness.ts';
import { Ledger } from '../src/ledger.ts';
import { renderMarkdown, buildBlueprint } from '../src/export.ts';
import type { FetchLike } from '../src/research.ts';

const SOURCE_TICTACTOE = resolve(import.meta.dirname, '..', '..', '..', 'blueprints', 'tictactoe');
/* The reference implementation, used as the fake worker's fixture source. Its
   layout matches core/engine's deliverables exactly, so a fixture dispatch is a
   real pass through the real gate rather than a simulated one. */
const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'tictactoe-vanilla-es6');

/** A project rooted in a temp dir with the tictactoe blueprint copied in. */
function project(): { harness: Harness; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'aose-harness-'));
  mkdirSync(join(root, 'blueprints'), { recursive: true });
  cpSync(SOURCE_TICTACTOE, join(root, 'blueprints', 'tictactoe'), { recursive: true });
  const harness = new Harness(root, new Ledger(':memory:'));
  return { harness, root };
}

const nl2contract = () => YAML.parse(readFileSync(join(SOURCE_TICTACTOE, 'sources', 'nl2contract.yaml'), 'utf8'));

/* A real arXiv record carries an abstract, and verification now checks that the
   recorded claim's own vocabulary appears in it, so the fixture must too. */
const verifiedFetch: FetchLike = async (url: string) => ({
  ok: true, status: 200,
  text: async () => url.includes('arxiv')
    ? '<feed><entry><title>Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?</title>'
      + '<summary>Generating preconditions alongside postconditions reduces the false alarms a verifier reports when contracts are checked.</summary></entry></feed>'
    : '{"full_name":"x/y","description":"preconditions postconditions verifier false alarms"}',
});

const mismatchFetch: FetchLike = async () => ({
  ok: true, status: 200,
  text: async () => '<feed><entry><title>AgriGov: A Structured Multilingual Dataset Curation for Indian Government Schemes for Farmers</title>'
    + '<summary>A trilingual dataset of Indian government agricultural schemes for farmers.</summary></entry></feed>',
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

test('an approval is bound to the content it approved, not merely to a timestamp', async () => {
  const { harness, root } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.addSource('tictactoe', nl2contract());
  harness.compile('tictactoe');
  await harness.verifySources('tictactoe', verifiedFetch);
  harness.lint('tictactoe');
  harness.review('tictactoe');
  harness.approve('tictactoe', 'owner');

  const approval = harness.ledger.activeApproval('tictactoe')!;
  assert.equal(approval.digest.length, 64, 'the approval records a digest of what was approved');
  assert.equal(approval.digest, harness.approvalDigest('tictactoe'));

  /* Edit a spec behind the harness's back, the way a person or another agent
     would. Nothing tells the ledger, so only the digest can catch it. */
  const spec = join(root, 'blueprints', 'tictactoe', 'core.engine.spec.yaml');
  writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n# a quiet edit after approval\n`);

  assert.notEqual(harness.approvalDigest('tictactoe'), approval.digest);
  await assert.rejects(
    () => harness.dispatch('tictactoe', { adapter: 'fake' }),
    /no longer matches what was approved/,
  );
  assert.equal(harness.ledger.activeApproval('tictactoe'), undefined,
    'the mismatch supersedes the approval rather than merely refusing once');
});

/** Change the blueprint so the approval digest moves, the way a real edit does. */
function editBlueprint(harness: Harness, slug: string, note: string): void {
  const path = join(harness.dir(slug), 'idea.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n# ${note}\n`);
}

/** Put a project back in BLOCKED the way an exhausted dispatch would. */
function block(harness: Harness, slug: string): void {
  harness.ledger.setState(slug, 'BLOCKED');
  harness.ledger.logTransition(slug, 'COMPILED', 'BLOCKED', 'exhausted', null);
}

test('the respec allowance counts re-specifications, not commands', () => {
  // The allowance bounds how many times a spec is rewritten after failure. It
  // used to be charged per invocation, so returning to COMPILED without
  // touching a byte spent one — the count measured typing, not respecifying.
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.compile('tictactoe');

  block(harness, 'tictactoe');
  editBlueprint(harness, 'tictactoe', 'first real change');
  const first = harness.respec('tictactoe', 'the engine spec was underspecified');
  assert.equal(first.allowed, true);
  assert.equal(first.state, 'COMPILED');
  assert.equal(first.remaining, 1);

  // Nothing changed since. Returning to COMPILED again respecifies nothing.
  block(harness, 'tictactoe');
  const free = harness.respec('tictactoe', 'looked again, changed nothing');
  assert.equal(free.allowed, true);
  assert.equal(free.remaining, 1, 'an unchanged respec must not spend the allowance');

  block(harness, 'tictactoe');
  editBlueprint(harness, 'tictactoe', 'second real change');
  assert.equal(harness.respec('tictactoe', 'again').remaining, 0);

  block(harness, 'tictactoe');
  editBlueprint(harness, 'tictactoe', 'third real change');
  const third = harness.respec('tictactoe', 'and again');
  assert.equal(third.allowed, false, 'the constitution allows two respecs, not an endless loop');
  assert.equal(third.remaining, 0);
  assert.equal(harness.ledger.getProject('tictactoe')!.state, 'BLOCKED');
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

/** Take a project all the way to APPROVED, ready to dispatch. */
async function approved(): Promise<Harness> {
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
  return harness;
}

test('the identical blueprint is not re-dispatched to the adapter it already failed on', async () => {
  // The waste this closes was real: the same blueprint was dispatched to the
  // same fake worker twice, producing byte-identical failures, and the harness
  // spent a respec allowance each time to allow it. A deterministic worker on
  // unchanged input cannot produce a new result.
  const harness = await approved();
  const first = await harness.dispatch('tictactoe', { domain: 'core/engine', adapter: 'fake', maxAttempts: 1 });
  assert.equal(first[0].passed, false, 'no fixtures, so this must fail');
  assert.equal(harness.ledger.getProject('tictactoe')!.state, 'BLOCKED');

  harness.respec('tictactoe', 'nothing changed');
  harness.lint('tictactoe');
  harness.review('tictactoe');
  harness.approve('tictactoe', 'owner');

  await assert.rejects(
    () => harness.dispatch('tictactoe', { domain: 'core/engine', adapter: 'fake', maxAttempts: 1 }),
    /already exhausted its attempts on "fake" with this exact blueprint/,
  );
});

test('the blocked key needs the domain, the adapter and the blueprint to all match', () => {
  // Tested directly, because the dispatch path skips this check on a dry run.
  // A test that dry-ran reached nothing, and for a while one silently did not:
  // dropping the adapter from the key broke no test at all.
  const digest = 'abc123';
  const blocked = [{ domain: 'core/engine', adapter: 'fake', digest }];

  assert.equal(matchBlocked(blocked, 'core/engine', 'fake', digest), digest, 'exact match is refused');

  // Each part of the key on its own must lift the refusal.
  assert.equal(matchBlocked(blocked, 'core/engine', 'claude', digest), null,
    'another worker on the same blueprint is cross-agent comparison, not a repeat');
  assert.equal(matchBlocked(blocked, 'core/engine', 'fake', 'different'), null,
    'a changed blueprint has something new to learn');
  assert.equal(matchBlocked(blocked, 'ui/client', 'fake', digest), null,
    'a different domain was never attempted');

  // Malformed or partial records must not match by accident: a missing field
  // reading as undefined on both sides would make every lookup a refusal.
  assert.equal(matchBlocked([{}, null, { domain: 'core/engine' }], 'core/engine', 'fake', digest), null);
});

test('a domain that already passed is not dispatched again', async () => {
  // This one costs money when it is wrong. Dispatch iterated the topological
  // order and re-ran every domain, so a project with one passing domain paid
  // to reproduce a result the ledger already held.
  const harness = await approved();
  const events: string[] = [];
  await harness.dispatch('tictactoe', {
    domain: 'core/engine', adapter: 'fake', maxAttempts: 1,
    fixtureRoot: FIXTURES, onEvent: (line) => events.push(line),
  });
  assert.ok(harness.ledger.domainPassed('tictactoe', 'core/engine'), events.join('\n'));

  const runsBefore = harness.ledger.runs('tictactoe').length;
  await harness.dispatch('tictactoe', {
    domain: 'core/engine', adapter: 'fake', maxAttempts: 1,
    fixtureRoot: FIXTURES, onEvent: (line) => events.push(line),
  });
  assert.equal(harness.ledger.runs('tictactoe').length, runsBefore, 'no second run may be recorded');
  assert.ok(events.some((line) => /already passed its gate with this blueprint/.test(line)),
    events.join('\n'));
});

test('converge names the domains still outstanding instead of the state machine', () => {
  // It used to throw `Illegal transition: cannot "converge_fail" from
  // DISPATCHED`, which describes the harness's difficulty rather than the
  // caller's mistake.
  const { harness } = project();
  harness.init('tictactoe');
  harness.capture('tictactoe');
  harness.ready('tictactoe');
  harness.compile('tictactoe');
  assert.throws(() => harness.converge('tictactoe'), /Still outstanding: core\/engine, ui\/client/);
});

test('a changed blueprint may be dispatched to the adapter it failed on', async () => {
  // The other half: the refusal must lift as soon as there is something new to
  // learn, or a failure would permanently retire an adapter for that domain.
  const harness = await approved();
  await harness.dispatch('tictactoe', { domain: 'core/engine', adapter: 'fake', maxAttempts: 1 });

  harness.respec('tictactoe', 'the gate command was wrong');
  editBlueprint(harness, 'tictactoe', 'a real change');
  harness.lint('tictactoe');
  harness.review('tictactoe');
  harness.approve('tictactoe', 'owner');

  const again = await harness.dispatch('tictactoe', { domain: 'core/engine', adapter: 'fake', maxAttempts: 1 });
  assert.equal(again.length, 1, 'the changed blueprint is allowed through');
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
