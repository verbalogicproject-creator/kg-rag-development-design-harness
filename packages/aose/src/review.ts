/**
 * Review, approval, and whole-project validation.
 *
 * Ported from the Codex harness's Harness.review/approve/validate
 * (blue/brainstorm-to-implementation-plan-harness/src/service.ts:13-26), which
 * established the rule this project needed most: a blueprint cannot become
 * final without a recorded human approval, and a decision may not cite a source
 * that is not in the ledger. Extended with the verification status check
 * (a recorded source is not a verified one) and approval supersession.
 */
import { lintDir } from './lint.ts';
import { replay } from './fsm.ts';
import type { Ledger } from './ledger.ts';
import type { Source, Idea, Constitution } from './schema.ts';
import type { Finding } from './lint.ts';

export interface ReviewResult { passed: boolean; findings: Finding[]; warnings: Finding[]; }

export function review(ledger: Ledger, slug: string, dir: string): ReviewResult {
  const sources = ledger.sources<Source>(slug);
  const approval = ledger.activeApproval(slug) ?? null;
  const latestEdit = ledger.latest<{ at: string }>(slug, 'artifact_edit')?.at ?? null;

  const result = lintDir(dir, { sources, approval, latestArtifactEdit: latestEdit });
  const findings = [...result.errors];

  /* Unverified sources block review even when no decision cites them yet, so a
     fabricated citation cannot sit in the ledger waiting to be cited later. */
  for (const source of sources) {
    if (source.verified.status === 'unverified') {
      findings.push({ id: 'LINT-17', severity: 'error', where: 'research ledger', message: `Source "${source.url}" has never been verified. Run "aose research-verify ${slug}".` });
    } else if (source.verified.status === 'mismatch') {
      findings.push({ id: 'LINT-17', severity: 'error', where: 'research ledger', message: `Source "${source.url}" did not match its recorded title. ${source.verified.detail}` });
    }
  }

  ledger.addRevision(slug, 'review', { passed: findings.length === 0, findings, warnings: result.warnings });
  if (findings.length) ledger.addFinding(slug, 'review', findings);
  return { passed: findings.length === 0, findings, warnings: result.warnings };
}

export function approve(ledger: Ledger, slug: string, dir: string, by: string): ReviewResult {
  const result = review(ledger, slug, dir);
  if (!result.passed) return result;
  ledger.addApproval(slug, by);
  return result;
}

export interface ValidationReport {
  valid: boolean;
  slug: string;
  state: string | null;
  errors: string[];
  replay_ok: boolean;
}

/** Whole-project audit: schema, transition log, approval integrity. */
export function validate(ledger: Ledger, slug: string, dir: string): ValidationReport {
  const project = ledger.getProject(slug);
  if (!project) return { valid: false, slug, state: null, errors: [`Unknown project: ${slug}`], replay_ok: false };

  const errors: string[] = [];
  const replayed = replay(ledger, slug);
  errors.push(...replayed.errors);

  const idea = ledger.latest<Idea>(slug, 'idea');
  const constitution = ledger.latest<Constitution>(slug, 'constitution');
  if (!constitution) errors.push('No constitution has been recorded.');
  if (!idea) errors.push('No idea has been captured.');

  const finalStates = ['APPROVED', 'DISPATCHED', 'GATED', 'CONVERGED', 'EXPORTED', 'ARCHIVED'];
  if (finalStates.includes(project.state) && !ledger.activeApproval(slug)) {
    errors.push(`State ${project.state} requires an active (non-superseded) approval, but none is recorded.`);
  }

  if (['CONVERGED', 'EXPORTED', 'ARCHIVED'].includes(project.state)) {
    const lintResult = lintDir(dir, { sources: ledger.sources<Source>(slug) });
    for (const finding of lintResult.errors) errors.push(`${finding.id} ${finding.where}: ${finding.message}`);
  }

  return { valid: errors.length === 0, slug, state: project.state, errors, replay_ok: replayed.valid };
}
