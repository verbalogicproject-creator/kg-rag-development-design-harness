/**
 * The workflow as an executable finite state machine.
 *
 * Alfredvc/aharness: "Prompts and skills can describe the process, but they
 * cannot enforce it." Codex's harness had a 6-state machine; this extends it
 * through dispatch, gate, converge and archive, and adds the repair edges
 * (gate-fail retry, BLOCKED -> respec) that the literature's loop-until-green
 * pattern needs but never bounds. Every bound is explicit here.
 */
import type { Ledger, ProjectState } from './ledger.ts';

export interface Transition {
  from: ProjectState | 'NONE';
  event: string;
  to: ProjectState;
}

/** The complete legal transition table. `aose validate` replays against it. */
export const TRANSITIONS: Transition[] = [
  { from: 'NONE', event: 'init', to: 'IDEA_DRAFT' },
  { from: 'IDEA_DRAFT', event: 'capture', to: 'IDEA_DRAFT' },
  { from: 'IDEA_DRAFT', event: 'ready', to: 'IDEA_READY' },
  { from: 'IDEA_READY', event: 'research', to: 'IDEA_READY' },
  { from: 'COMPILED', event: 'research', to: 'COMPILED' },
  { from: 'LINTED', event: 'research', to: 'LINTED' },
  { from: 'IDEA_READY', event: 'compile', to: 'COMPILED' },
  { from: 'COMPILED', event: 'compile', to: 'COMPILED' },
  { from: 'LINTED', event: 'compile', to: 'COMPILED' },
  { from: 'AWAITING_APPROVAL', event: 'compile', to: 'COMPILED' },
  { from: 'APPROVED', event: 'compile', to: 'COMPILED' },
  { from: 'BLOCKED', event: 'respec', to: 'COMPILED' },
  { from: 'COMPILED', event: 'lint', to: 'LINTED' },
  { from: 'LINTED', event: 'lint', to: 'LINTED' },
  { from: 'LINTED', event: 'review', to: 'AWAITING_APPROVAL' },
  { from: 'AWAITING_APPROVAL', event: 'review', to: 'AWAITING_APPROVAL' },
  { from: 'AWAITING_APPROVAL', event: 'approve', to: 'APPROVED' },
  { from: 'APPROVED', event: 'dispatch', to: 'DISPATCHED' },
  { from: 'DISPATCHED', event: 'dispatch', to: 'DISPATCHED' },
  { from: 'GATED', event: 'dispatch', to: 'DISPATCHED' },
  { from: 'DISPATCHED', event: 'gate_pass', to: 'GATED' },
  { from: 'DISPATCHED', event: 'gate_partial', to: 'DISPATCHED' },
  { from: 'DISPATCHED', event: 'gate_fail', to: 'DISPATCHED' },
  { from: 'DISPATCHED', event: 'exhausted', to: 'BLOCKED' },
  { from: 'GATED', event: 'converge', to: 'CONVERGED' },
  { from: 'GATED', event: 'converge_fail', to: 'GATED' },
  { from: 'CONVERGED', event: 'export', to: 'EXPORTED' },
  { from: 'EXPORTED', event: 'archive', to: 'ARCHIVED' },
  /* A defect found after export.
     
     The lifecycle modelled idea-to-export as one way, so an exported project
     had exactly one legal move: archive. That is only right if export means
     correct, and it does not — LINT-36 found a shipped bundle that no browser
     could load AFTER this project exported, from a contradiction the blueprint
     had stated all along. Without a way back the choices were to archive
     something broken or to edit the ledger by hand, and the second is how a
     state machine stops meaning anything.
     
     `respec` is already the "the specification was wrong, go fix it" edge, and
     its allowance already bounds how often that can happen, so this reuses
     both rather than inventing a softer door. */
  { from: 'EXPORTED', event: 'respec', to: 'COMPILED' },
  { from: 'IDEA_DRAFT', event: 'abandon', to: 'ABANDONED' },
  { from: 'IDEA_READY', event: 'abandon', to: 'ABANDONED' },
  { from: 'COMPILED', event: 'abandon', to: 'ABANDONED' },
  { from: 'LINTED', event: 'abandon', to: 'ABANDONED' },
  { from: 'AWAITING_APPROVAL', event: 'abandon', to: 'ABANDONED' },
  { from: 'APPROVED', event: 'abandon', to: 'ABANDONED' },
  { from: 'DISPATCHED', event: 'abandon', to: 'ABANDONED' },
  { from: 'BLOCKED', event: 'abandon', to: 'ABANDONED' },
];

export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly event: string;
  constructor(from: string, event: string) {
    super(`Illegal transition: cannot "${event}" from ${from}. Legal events here: ${legalEvents(from).join(', ') || '(none)'}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.event = event;
  }
}

export function legalEvents(from: string): string[] {
  return [...new Set(TRANSITIONS.filter((t) => t.from === from).map((t) => t.event))];
}

export function nextState(from: ProjectState | 'NONE', event: string): ProjectState {
  const match = TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (!match) throw new IllegalTransitionError(from, event);
  return match.to;
}

/** Apply an event to a project, recording the transition with its evidence. */
export function apply(ledger: Ledger, slug: string, event: string, evidenceRevisionId: number | null = null): ProjectState {
  const project = ledger.getProject(slug);
  if (!project) throw new Error(`Unknown project: ${slug}`);
  const to = nextState(project.state, event);
  ledger.setState(slug, to);
  ledger.logTransition(slug, project.state, to, event, evidenceRevisionId);
  return to;
}

/** Replay the transition log; every recorded move must be legal and contiguous. */
export function replay(ledger: Ledger, slug: string): { valid: boolean; errors: string[]; state: ProjectState | null } {
  const project = ledger.getProject(slug);
  if (!project) return { valid: false, errors: [`Unknown project: ${slug}`], state: null };
  const errors: string[] = [];
  let cursor: ProjectState | 'NONE' = 'NONE';
  for (const row of ledger.transitions(slug)) {
    if (row.from_state !== cursor) {
      errors.push(`Transition log is not contiguous: expected to leave ${cursor} but log says ${row.from_state}.`);
      break;
    }
    let to: ProjectState;
    try {
      to = nextState(cursor, row.event);
    } catch {
      errors.push(`Illegal recorded transition: "${row.event}" from ${cursor}.`);
      break;
    }
    if (to !== row.to_state) {
      errors.push(`Recorded transition "${row.event}" from ${cursor} should reach ${to}, log says ${row.to_state}.`);
      break;
    }
    cursor = to;
  }
  if (!errors.length && cursor !== project.state) {
    errors.push(`Project state ${project.state} is not reachable by replaying its transition log (replay ends at ${cursor}).`);
  }
  return { valid: errors.length === 0, errors, state: project.state };
}

/** Attempt budget for one domain. Bounds the loop the papers leave unbounded. */
export function attemptBudget(ledger: Ledger, slug: string, domain: string, maxAttempts: number, adapter?: string):
  { allowed: boolean; used: number; remaining: number } {
  const used = ledger.attemptsFor(slug, domain, adapter);
  return { allowed: used < maxAttempts, used, remaining: Math.max(0, maxAttempts - used) };
}
