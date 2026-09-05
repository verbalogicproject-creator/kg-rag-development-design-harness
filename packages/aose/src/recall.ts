/**
 * The remember plane, read side.
 *
 * `research` verifies claims made about the outside world. This is the same
 * discipline pointed inward: what has this harness already decided, and what
 * did it decide it about? A worker that starts cold every time re-derives the
 * same failures, and the harness already holds the evidence that it did.
 *
 * Retrieval here is an **exact join on declared constraint ids**, not a
 * similarity search. `constitution_articles` and `verified_by` already name
 * which constraints apply to a task, and a run records which constraints it was
 * held to — so relevance is a fact rather than a guess. That matters: two
 * independent projects measured graph-and-vector retrieval returning a
 * confident wrong answer on paraphrastic input, and concluded no score
 * threshold separates fluent-irrelevant text from genuine signal. A join has no
 * threshold to be wrong about.
 *
 * What comes back is the FAILURE record, never exemplar code. Failures are
 * denser — a few lines against a whole file — and they do not collapse the
 * solution space, which matters when several agents are supposed to converge on
 * a specification independently rather than copy each other.
 */
import type { Ledger, RunRow } from './ledger.ts';

export interface PriorFailure {
  /** Every constraint this failure was recorded under, not one line per constraint. */
  constraints: string[];
  detail: string;
  /** How many distinct runs hit it. A thing seen four times is not an anecdote. */
  seen_in: number;
  resolved_by: string;
}

export interface RecallResult {
  domain: string;
  from_runs: number;
  shared_constraints: string[];
  known_failures: PriorFailure[];
  /** Rendered payload section, empty when there is nothing worth carrying. */
  text: string;
}

/** Constraint ids a run was held to, as recorded when it started. */
function constraintsOf(run: RunRow & { constraints?: string }): string[] {
  try { const parsed = JSON.parse(run.constraints ?? '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

/**
 * What prior work says about a domain about to be dispatched.
 *
 * Empty is the correct and common answer, especially early. An empty recall
 * that says so beats a populated one that guessed.
 */
export function recall(
  ledger: Ledger,
  slug: string,
  domain: string,
  constraints: string[],
  options: { maxFailures?: number; maxChars?: number } = {},
): RecallResult {
  const maxFailures = options.maxFailures ?? 6;
  const maxChars = options.maxChars ?? 1200;
  const wanted = new Set(constraints);

  /* Every run of this domain, in this project and any other. A failure under
     the same constraint is relevant wherever it happened — that is the point of
     joining on the constraint rather than on the project. */
  const candidates = ledger.allRuns()
    .filter((run) => run.domain === domain)
    .filter((run) => run.gate_exit !== null && run.gate_exit !== 0);

  const shared = new Set<string>();
  /* Grouped by the failure, not by the constraint. One cause matching three
     constraints is one thing to avoid, and printing it three times spends
     payload budget to say the same sentence again. */
  const byDetail = new Map<string, { constraints: Set<string>; runs: number }>();

  for (const run of candidates) {
    const overlap = constraintsOf(run).filter((id) => wanted.has(id));
    if (!overlap.length) continue;
    for (const id of overlap) shared.add(id);

    const detail = (run.notes ?? '').trim().split('\n')[0].slice(0, 160);
    if (!detail) continue;
    const entry = byDetail.get(detail) ?? { constraints: new Set<string>(), runs: 0 };
    for (const id of overlap) entry.constraints.add(id);
    entry.runs += 1;
    byDetail.set(detail, entry);
  }

  /* A later passing run under a shared constraint is how the failure was
     resolved — evidence, not annotation. */
  const passes = ledger.allRuns().filter((run) => run.domain === domain && run.gate_exit === 0);
  const failures: PriorFailure[] = [...byDetail].map(([detail, entry]) => {
    const fix = passes.find((run) =>
      constraintsOf(run).some((id) => entry.constraints.has(id)) && (run.notes ?? '').trim());
    return {
      constraints: [...entry.constraints].sort(),
      detail,
      seen_in: entry.runs,
      resolved_by: fix ? fix.notes.trim().split('\n')[0].slice(0, 120) : '',
    };
  });
  failures.sort((a, b) => b.seen_in - a.seen_in || a.detail.localeCompare(b.detail));
  const kept = failures.slice(0, maxFailures);

  return {
    domain,
    from_runs: candidates.length,
    shared_constraints: [...shared].sort(),
    known_failures: kept,
    text: render(domain, kept, candidates.length, maxChars),
  };
}

/** The payload section. Bounded, because context is a finite resource (LINT-24). */
function render(domain: string, failures: PriorFailure[], runs: number, maxChars: number): string {
  if (!failures.length) return '';
  const lines = [
    '## What went wrong here before',
    '',
    `Drawn from ${runs} prior failing run(s) of \`${domain}\`, matched on the constraints this`,
    'task declares. Avoid these; do not treat them as the only way to fail.',
    '',
  ];
  for (const failure of failures) {
    lines.push(`- **${failure.constraints.join(', ')}** — ${failure.detail}`);
    lines.push(`  seen in ${failure.seen_in} run(s)${failure.resolved_by ? `; resolved by: ${failure.resolved_by}` : ''}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}
