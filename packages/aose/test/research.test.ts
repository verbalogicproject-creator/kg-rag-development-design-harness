import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, titleSimilarity, normalizeTitle, classifyUrl } from '../src/research.ts';
import type { FetchLike } from '../src/research.ts';
import type { Source } from '../src/schema.ts';

const source = (over: Partial<Source> = {}): Source => ({
  url: 'https://arxiv.org/abs/2510.12702', kind: 'arxiv', title: 'T', claim: 'C', confidence: 'medium',
  supports: [], verified: { status: 'unverified', fetched_title: '', checked_at: '', detail: '' }, ...over,
});

const arxivFeed = (title: string) => `<feed><entry><id>x</id><title>${title}</title></entry></feed>`;
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

test('a matching arXiv title verifies', async () => {
  const outcome = await verify(
    source({ title: 'Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?' }),
    stub(arxivFeed('Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?')),
  );
  assert.equal(outcome.status, 'verified');
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

test('a paraphrased-but-real title still verifies above threshold', async () => {
  const outcome = await verify(
    source({ url: 'https://arxiv.org/abs/2602.22302', title: 'Agent Behavioral Contracts: Formal Specification and Runtime Enforcement for Reliable Autonomous AI Agents' }),
    stub(arxivFeed('Agent Behavioral Contracts: Formal Specification and Runtime Enforcement for Reliable Autonomous AI Agents')),
  );
  assert.equal(outcome.status, 'verified');
});

test('an arXiv id with no record is unreachable, not verified', async () => {
  const outcome = await verify(source({ url: 'https://arxiv.org/abs/9999.99999' }), stub('<feed></feed>'));
  assert.equal(outcome.status, 'unreachable');
});

test('an existing GitHub repository verifies and a missing one mismatches', async () => {
  const repo = source({ url: 'https://github.com/Alfredvc/aharness', kind: 'github', title: 'aharness' });
  assert.equal((await verify(repo, stub(JSON.stringify({ full_name: 'Alfredvc/aharness' })))).status, 'verified');
  assert.equal((await verify(repo, stub('{}', false, 404))).status, 'mismatch');
});

test('a web page is checked against its title element', async () => {
  const page = source({ url: 'https://example.com/harness', kind: 'web', title: 'Harness engineering' });
  assert.equal((await verify(page, stub('<html><head><title>Harness engineering</title></head></html>'))).status, 'verified');
  assert.equal((await verify(page, stub('<html><head><title>Totally different page</title></head></html>'))).status, 'mismatch');
  assert.equal((await verify(page, stub('<html><head></head></html>'))).status, 'unreachable');
});

test('a network failure is reported as unreachable rather than swallowed', async () => {
  const throwing: FetchLike = async () => { throw new Error('ENOTFOUND'); };
  const outcome = await verify(source(), throwing);
  assert.equal(outcome.status, 'unreachable');
  assert.match(outcome.detail, /ENOTFOUND/);
});
