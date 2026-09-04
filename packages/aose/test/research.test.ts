import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, titleSimilarity, normalizeTitle, classifyUrl } from '../src/research.ts';
import type { FetchLike } from '../src/research.ts';
import type { Source } from '../src/schema.ts';

const source = (over: Partial<Source> = {}): Source => ({
  url: 'https://arxiv.org/abs/2510.12702', kind: 'arxiv', title: 'T', claim: 'C', confidence: 'medium',
  supports: [], verified: { status: 'unverified', fetched_title: '', checked_at: '', detail: '' }, ...over,
});

const arxivFeed = (title: string, summary = '') =>
  `<feed><entry><id>x</id><title>${title}</title><summary>${summary}</summary></entry></feed>`;
const stub = (body: string, ok = true, status = 200): FetchLike =>
  async () => ({ ok, status, text: async () => body });

test('title similarity ignores stop words and punctuation', () => {
  assert.deepEqual(normalizeTitle('The Design of a System!'), ['design', 'system']);
  assert.equal(titleSimilarity('Agent Behavioral Contracts', 'agent behavioral contracts'), 1);
});

test('classifyUrl routes arxiv, github and generic pages', () => {
  assert.equal(classifyUrl('https://arxiv.org/abs/2602.22302'), 'arxiv');
  assert.equal(classifyUrl('https://github.com/Alfredvc/aharness'), 'github');
  assert.equal(classifyUrl('https://example.com/post'), 'web');
});

/* The six citations audited at the start of this project. Two agents recorded
   them; one of the six was fabricated. These fixtures are the real titles. */

test('a matching arXiv title whose abstract carries the claim verifies', async () => {
  const outcome = await verify(
    source({
      title: 'Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?',
      claim: 'Generating preconditions alongside postconditions reduces verifier false alarms.',
    }),
    stub(arxivFeed(
      'Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?',
      'We study whether models can infer preconditions as well as postconditions, and find that generating preconditions reduces false alarms reported by the verifier.',
    )),
  );
  assert.equal(outcome.status, 'verified');
  assert.ok((outcome.claim_support ?? 0) >= 0.5);
  assert.equal(outcome.canonical_id, 'arXiv:2510.12702');
  assert.match(outcome.excerpt ?? '', /preconditions/);
});

test('the right paper with a claim it does not make is a mismatch, not a pass', async () => {
  const outcome = await verify(
    source({
      title: 'Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?',
      claim: 'Multi agent orchestration eliminates the need for human approval gates entirely.',
    }),
    stub(arxivFeed(
      'Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?',
      'We study whether models can infer preconditions as well as postconditions for program verification.',
    )),
  );
  assert.equal(outcome.status, 'mismatch');
  assert.match(outcome.detail, /right paper/);
});

test('a similar title alone no longer verifies an unrelated claim', async () => {
  // The threshold that let "Harness Security Design" pass against "Harness
  // Security" is now backed by a check on the claim's own vocabulary.
  const outcome = await verify(
    source({ url: 'https://example.org/harness', kind: 'web', title: 'Harness Security Design', claim: 'Cold dispatch prevents context leakage between domains.' }),
    stub('<html><head><title>Harness Security</title></head><body>A short note about locking sheds.</body></html>'),
  );
  assert.equal(outcome.status, 'mismatch');
});

test('the fabricated citation is caught: 2606.08272 resolves to an unrelated paper', async () => {
  const outcome = await verify(
    source({ url: 'https://arxiv.org/abs/2606.08272', title: 'Specification-Driven Development for AI-Native Enterprise Software' }),
    stub(arxivFeed('AgriGov: A Structured Multilingual Dataset Curation for Indian Government Schemes for Farmers')),
  );
  assert.equal(outcome.status, 'mismatch');
  assert.match(outcome.detail, /AgriGov/);
  assert.match(outcome.detail, /does not match the cited title/);
});

test('a real paper whose abstract supports the claim verifies', async () => {
  const outcome = await verify(
    source({
      url: 'https://arxiv.org/abs/2602.22302',
      title: 'Agent Behavioral Contracts: Formal Specification and Runtime Enforcement for Reliable Autonomous AI Agents',
      claim: 'Runtime contracts bound behavioral drift in agents.',
    }),
    stub(arxivFeed(
      'Agent Behavioral Contracts: Formal Specification and Runtime Enforcement for Reliable Autonomous AI Agents',
      'We introduce runtime contracts for agents and prove a bound on behavioral drift under repeated execution.',
    )),
  );
  assert.equal(outcome.status, 'verified');
});

test('an arXiv id with no record is unreachable, not verified', async () => {
  const outcome = await verify(source({ url: 'https://arxiv.org/abs/9999.99999' }), stub('<feed></feed>'));
  assert.equal(outcome.status, 'unreachable');
});

test('an existing GitHub repository verifies and a missing one mismatches', async () => {
  const repo = source({ url: 'https://github.com/Alfredvc/aharness', kind: 'github', title: 'aharness', claim: 'A workflow harness enforcing approval gates.' });
  assert.equal((await verify(repo, stub(JSON.stringify({ full_name: 'Alfredvc/aharness', description: 'A workflow harness enforcing approval gates for Codex.' })))).status, 'verified');
  assert.equal((await verify(repo, stub('{}', false, 404))).status, 'mismatch');
});

test('a web page must match its title and contain the claim it was cited for', async () => {
  const page = source({ url: 'https://example.org/harness', kind: 'web', title: 'Harness engineering', claim: 'Context is a scarce resource for coding agents.' });
  assert.equal((await verify(page, stub('<html><head><title>Harness engineering</title></head><body>Context is a scarce resource, so agents need a small instruction file.</body></html>'))).status, 'verified');
  assert.equal((await verify(page, stub('<html><head><title>Totally different page</title></head></html>'))).status, 'mismatch');
  assert.equal((await verify(page, stub('<html><head></head></html>'))).status, 'unreachable');
});

test('a network failure is reported as unreachable rather than swallowed', async () => {
  const throwing: FetchLike = async () => { throw new Error('ENOTFOUND'); };
  const outcome = await verify(source(), throwing);
  assert.equal(outcome.status, 'unreachable');
  assert.match(outcome.detail, /ENOTFOUND/);
});
