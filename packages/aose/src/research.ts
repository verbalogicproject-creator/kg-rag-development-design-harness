/**
 * Research ledger verification.
 *
 * The Codex harness required that a cited decision reference a source recorded
 * in its ledger, but recording a URL is not evidence the URL says what the
 * claim says. In this very project, one agent cited arXiv:2606.08272 as
 * "Specification-Driven Development for AI-Native Enterprise Software"; the id
 * actually resolves to a paper on Indian agricultural schemes. CiteCheck
 * (arXiv:2605.27700) makes the general point: LLM self-citation fabricates, and
 * only retrieval-grounded checking catches it. So `verify` fetches the source
 * and compares the fetched title with the claimed one.
 */
import type { Source, VerifyStatus } from './schema.ts';

export interface VerifyOutcome {
  status: VerifyStatus;
  fetched_title: string;
  checked_at: string;
  detail: string;
  /** Text actually retrieved, so a later reader can judge the claim themselves. */
  excerpt?: string;
  /** Fraction of the claim's content words found in the retrieved text. */
  claim_support?: number;
  /** The exact identifier matched, where the source has one. */
  canonical_id?: string;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'in', 'on', 'to', 'with', 'via', 'at', 'by']);

export function normalizeTitle(title: string): string[] {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * How much of a claim's vocabulary actually appears in the retrieved text.
 *
 * Title similarity alone proved too weak: a fabricated "Harness Security
 * Design" scores two thirds against a real "Harness Security", and the claim
 * attached to it was never examined at all. This does not decide whether the
 * source supports the claim, which needs a reader, but it separates a claim
 * whose vocabulary is present from one that is nowhere in the document.
 */
export function claimSupport(claim: string, body: string): number {
  const words = new Set(normalizeTitle(claim));
  if (!words.size) return 0;
  const haystack = ` ${body.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let present = 0;
  for (const word of words) if (haystack.includes(` ${word} `)) present += 1;
  return present / words.size;
}

/** Jaccard similarity over content words. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a));
  const right = new Set(normalizeTitle(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const ARXIV_ID = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/i;
export const GITHUB_REPO = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i;

export function classifyUrl(url: string): 'arxiv' | 'github' | 'web' {
  if (ARXIV_ID.test(url)) return 'arxiv';
  if (GITHUB_REPO.test(url)) return 'github';
  return 'web';
}

/** Fetch a source and decide whether it supports the claim it was recorded for. */
export async function verify(source: Source, fetchImpl: FetchLike, options: { threshold?: number; claimThreshold?: number; timeoutMs?: number } = {}): Promise<VerifyOutcome> {
  /* Identity is checked strictly. For arXiv and GitHub the id or repo path IS
     the identity, so the title check is a cross-check against a transposed id;
     for a generic page the title is all there is. Separately, the claim's own
     terms must appear in what was retrieved. */
  const threshold = options.threshold ?? 0.6;
  const claimThreshold = options.claimThreshold ?? 0.5;
  const checkedAt = new Date().toISOString();
  const fail = (status: VerifyStatus, detail: string, fetchedTitle = ''): VerifyOutcome =>
    ({ status, fetched_title: fetchedTitle, checked_at: checkedAt, detail });

  const arxiv = ARXIV_ID.exec(source.url);
  const github = GITHUB_REPO.exec(source.url);

  try {
    if (arxiv) {
      const id = arxiv[1];
      const response = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${id}`);
      if (!response.ok) return fail('unreachable', `arXiv API returned HTTP ${response.status}.`);
      const body = await response.text();
      if (/<entry>[\s\S]*?<title>Error<\/title>/i.test(body) || !/<entry>/i.test(body)) {
        return fail('unreachable', `arXiv has no record for ${id}.`);
      }
      const match = /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/i.exec(body);
      const fetchedTitle = (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
      const summary = (/<summary>([\s\S]*?)<\/summary>/i.exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();
      const score = titleSimilarity(source.title, fetchedTitle);
      const support = claimSupport(source.claim, `${fetchedTitle} ${summary}`);
      if (score < threshold) {
        return fail('mismatch', `arXiv ${id} is titled "${fetchedTitle}", which does not match the cited title (similarity ${score.toFixed(2)}).`, fetchedTitle);
      }
      if (support < claimThreshold) {
        return { status: 'mismatch', fetched_title: fetchedTitle, checked_at: checkedAt,
          detail: `arXiv ${id} is the right paper, but only ${(support * 100).toFixed(0)}% of the recorded claim's terms appear in its title and abstract. Reword the claim to what the source says, or cite a source that says it.`,
          excerpt: summary.slice(0, 600), claim_support: support, canonical_id: `arXiv:${id}` };
      }
      return { status: 'verified', fetched_title: fetchedTitle, checked_at: checkedAt,
        detail: `arXiv ${id}: title similarity ${score.toFixed(2)}, claim terms present ${(support * 100).toFixed(0)}%.`,
        excerpt: summary.slice(0, 600), claim_support: support, canonical_id: `arXiv:${id}` };
    }

    if (github) {
      const [, owner, repo] = github;
      const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}`);
      if (response.status === 404) return fail('mismatch', `GitHub repository ${owner}/${repo} does not exist.`);
      if (!response.ok) return fail('unreachable', `GitHub API returned HTTP ${response.status}.`);
      const body = await response.text();
      let fullName = '';
      let description = '';
      try {
        const doc = JSON.parse(body) as { full_name?: string; description?: string };
        fullName = doc.full_name ?? '';
        description = doc.description ?? '';
      } catch { /* keep empty */ }
      const support = claimSupport(source.claim, `${fullName} ${description}`);
      return { status: 'verified', fetched_title: fullName || `${owner}/${repo}`, checked_at: checkedAt,
        detail: `Repository exists. Claim terms present in its description: ${(support * 100).toFixed(0)}%.`,
        excerpt: description.slice(0, 400), claim_support: support, canonical_id: fullName || `${owner}/${repo}` };
    }

    const response = await fetchImpl(source.url);
    if (!response.ok) return fail('unreachable', `HTTP ${response.status}.`);
    const body = await response.text();
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!title) return fail('unreachable', 'Page returned no <title>; could not confirm identity.');
    const score = titleSimilarity(source.title, title);
    if (score < threshold) {
      return fail('mismatch', `Page is titled "${title}" (similarity ${score.toFixed(2)}).`, title);
    }
    /* A page with a similar title is not evidence for whatever claim was
       attached to it, so the claim's own vocabulary has to be in the text. */
    const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const support = claimSupport(source.claim, text);
    if (support < claimThreshold) {
      return { status: 'mismatch', fetched_title: title, checked_at: checkedAt,
        detail: `The page is titled as cited, but only ${(support * 100).toFixed(0)}% of the recorded claim's terms appear anywhere in it.`,
        excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 600), claim_support: support };
    }
    return { status: 'verified', fetched_title: title, checked_at: checkedAt,
      detail: `Page title similarity ${score.toFixed(2)}, claim terms present ${(support * 100).toFixed(0)}%.`,
      excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 600), claim_support: support };
  } catch (error) {
    return fail('unreachable', `Fetch failed: ${(error as Error).message}`);
  }
}
