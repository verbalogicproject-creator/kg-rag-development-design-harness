/**
 * Converge: a scored gate, not a binary one.
 *
 * Adapted from tikalk/agentic-sdlc-spec-kit's "converge" phase, the only tool
 * in the survey that scores rather than passes/fails. Every component here is
 * computed from artifacts the harness already holds — files on disk, the gate's
 * own exit code, the transition log — so no pillar is a judgement call.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Spec, Task, Source } from './schema.ts';

export interface PillarScore { name: string; score: number; components: { label: string; earned: number; possible: number; detail: string }[]; }
export interface ConvergeReport {
  domain: string;
  passed: boolean;
  threshold: number;
  pillars: PillarScore[];
  generated_at: string;
}

export interface ConvergeInput {
  domain: string;
  worktree: string;
  spec: Spec;
  task: Task['task'];
  gateExit: number | null;
  gateStdout: string;
  gateStdoutSha: string;
  sources: Source[];
  citedUrls: string[];
  approvalAt: string | null;
  firstDispatchAt: string | null;
  threshold?: number;
}

const PLACEHOLDER = /\b(TODO|FIXME|not implemented|unimplemented|placeholder)\b/i;

/** Does this file export the given name? */
export function exportsName(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`export\\s+(?:async\\s+)?(?:default\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${escaped}\\b`).test(source)
    || new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source);
}

function changedFiles(worktree: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' });
    return out.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).filter((f) => !f.startsWith('.aose/'));
  } catch {
    return [];
  }
}

export function converge(input: ConvergeInput): ConvergeReport {
  const threshold = input.threshold ?? 70;
  const { worktree, spec, task } = input;

  const read = (file: string): string | null => {
    const path = join(worktree, file);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  };

  /* ---- Pillar 1: spec compliance ---- */
  const present = task.deliverables.filter((f) => read(f) !== null);
  const contents = task.deliverables.map((f) => read(f) ?? '').join('\n');
  const contractNames = Object.keys(spec.contracts)
    .map((sig) => sig.slice(0, Math.max(0, sig.indexOf('('))).trim())
    .filter(Boolean);
  const foundExports = contractNames.filter((name) => exportsName(contents, name));

  const specCompliance: PillarScore = {
    name: 'Spec compliance',
    score: 0,
    components: [
      { label: 'deliverables present', earned: ratio(present.length, task.deliverables.length) * 50, possible: 50,
        detail: `${present.length}/${task.deliverables.length} files exist` },
      { label: 'contract exports found', earned: ratio(foundExports.length, contractNames.length) * 50, possible: 50,
        detail: contractNames.length ? `${foundExports.length}/${contractNames.length} exported` : 'no contracts declared' },
    ],
  };

  /* ---- Pillar 2: test adequacy ---- */
  const scenarioNames = spec.verification.scenarios.map((s) => s.test_name);
  const testSource = read(spec.verification.test_suite) ?? '';
  const haystack = `${input.gateStdout}\n${testSource}`;
  const foundScenarios = scenarioNames.filter((name) => haystack.includes(name));

  const testAdequacy: PillarScore = {
    name: 'Test adequacy',
    score: 0,
    components: [
      { label: 'gate exit 0', earned: input.gateExit === 0 ? 60 : 0, possible: 60, detail: `gate exited ${input.gateExit}` },
      { label: 'scenarios covered by named tests', earned: ratio(foundScenarios.length, scenarioNames.length) * 40, possible: 40,
        detail: `${foundScenarios.length}/${scenarioNames.length} scenario test names found` },
    ],
  };

  /* ---- Pillar 3: code quality ---- */
  const changed = changedFiles(worktree);
  const outOfScope = changed.filter((f) => !task.deliverables.includes(f));
  const placeholders = task.deliverables.filter((f) => PLACEHOLDER.test(read(f) ?? ''));
  const empty = present.filter((f) => (read(f) ?? '').trim().length === 0);

  const codeQuality: PillarScore = {
    name: 'Code quality',
    score: 0,
    components: [
      { label: 'changes stay inside deliverables', earned: outOfScope.length === 0 ? 50 : Math.max(0, 50 - outOfScope.length * 10), possible: 50,
        detail: outOfScope.length ? `out of scope: ${outOfScope.slice(0, 5).join(', ')}` : 'no out-of-scope edits' },
      { label: 'no placeholder markers', earned: placeholders.length === 0 ? 25 : 0, possible: 25,
        detail: placeholders.length ? `placeholders in ${placeholders.join(', ')}` : 'clean' },
      { label: 'no empty deliverables', earned: empty.length === 0 ? 25 : 0, possible: 25,
        detail: empty.length ? `empty: ${empty.join(', ')}` : 'all non-empty' },
    ],
  };

  /* ---- Pillar 4: risk and evidence ---- */
  const cited = input.citedUrls;
  const verifiedCited = cited.filter((url) => input.sources.find((s) => s.url === url)?.verified.status === 'verified');
  const approvalFirst = Boolean(input.approvalAt && input.firstDispatchAt && input.approvalAt <= input.firstDispatchAt);

  const riskEvidence: PillarScore = {
    name: 'Risk & evidence',
    score: 0,
    components: [
      { label: 'cited sources verified', earned: cited.length === 0 ? 40 : ratio(verifiedCited.length, cited.length) * 40, possible: 40,
        detail: cited.length ? `${verifiedCited.length}/${cited.length} verified` : 'no citations to verify' },
      { label: 'approval precedes dispatch', earned: approvalFirst ? 30 : 0, possible: 30,
        detail: approvalFirst ? 'approval recorded before first dispatch' : 'no approval recorded before dispatch' },
      { label: 'gate evidence produced by harness', earned: input.gateStdoutSha ? 30 : 0, possible: 30,
        detail: input.gateStdoutSha ? `stdout sha256 ${input.gateStdoutSha.slice(0, 12)}` : 'no harness-produced gate hash' },
    ],
  };

  const pillars = [specCompliance, testAdequacy, codeQuality, riskEvidence];
  for (const pillar of pillars) {
    pillar.score = Math.round(pillar.components.reduce((sum, c) => sum + c.earned, 0));
  }

  return {
    domain: input.domain,
    passed: pillars.every((p) => p.score >= threshold),
    threshold,
    pillars,
    generated_at: new Date().toISOString(),
  };
}

function ratio(part: number, total: number): number {
  if (total === 0) return 1;
  return Math.max(0, Math.min(1, part / total));
}

export function formatConverge(report: ConvergeReport): string {
  const lines = [`Converge — ${report.domain} (threshold ${report.threshold})`];
  for (const pillar of report.pillars) {
    lines.push(`  ${pillar.score >= report.threshold ? 'PASS' : 'FAIL'}  ${pillar.name.padEnd(18)} ${String(pillar.score).padStart(3)}`);
    for (const component of pillar.components) {
      lines.push(`          ${Math.round(component.earned)}/${component.possible}  ${component.label} — ${component.detail}`);
    }
  }
  lines.push(report.passed ? 'RESULT: CONVERGED' : 'RESULT: NOT CONVERGED');
  return lines.join('\n');
}
