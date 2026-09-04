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

export interface VerifyOutcome { status: VerifyStatus; fetched_title: string; checked_at: string; detail: string; }
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'in', 'on', 'to', 'with', 'via', 'at', 'by']);

export function normalizeTitle(title: string): string[] {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
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
export async function verify(source: Source, fetchImpl: FetchLike, options: { threshold?: number; timeoutMs?: number } = {}): Promise<VerifyOutcome> {
  const threshold = options.threshold ?? 0.5;
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
      const score = titleSimilarity(source.title, fetchedTitle);
      if (score >= threshold) {
        return { status: 'verified', fetched_title: fetchedTitle, checked_at: checkedAt, detail: `arXiv title similarity ${score.toFixed(2)}.` };
      }
      return fail('mismatch', `arXiv ${id} is titled "${fetchedTitle}", which does not match the cited title (similarity ${score.toFixed(2)}).`, fetchedTitle);
    }

    if (github) {
      const [, owner, repo] = github;
      const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}`);
      if (response.status === 404) return fail('mismatch', `GitHub repository ${owner}/${repo} does not exist.`);
      if (!response.ok) return fail('unreachable', `GitHub API returned HTTP ${response.status}.`);
      const body = await response.text();
      let fullName = '';
      try { fullName = (JSON.parse(body) as { full_name?: string }).full_name ?? ''; } catch { /* keep empty */ }
      return { status: 'verified', fetched_title: fullName || `${owner}/${repo}`, checked_at: checkedAt, detail: 'Repository exists.' };
    }

    const response = await fetchImpl(source.url);
    if (!response.ok) return fail('unreachable', `HTTP ${response.status}.`);
    const body = await response.text();
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!title) return fail('unreachable', 'Page returned no <title>; could not confirm identity.');
    const score = titleSimilarity(source.title, title);
    if (score >= threshold) {
      return { status: 'verified', fetched_title: title, checked_at: checkedAt, detail: `Page title similarity ${score.toFixed(2)}.` };
    }
    return fail('mismatch', `Page is titled "${title}" (similarity ${score.toFixed(2)}).`, title);
  } catch (error) {
    return fail('unreachable', `Fetch failed: ${(error as Error).message}`);
  }
}
