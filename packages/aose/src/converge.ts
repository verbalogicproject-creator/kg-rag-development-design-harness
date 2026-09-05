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
import { undeclaredHosts } from './lint.ts';

export interface PillarScore { name: string; score: number; components: { label: string; earned: number; possible: number; detail: string }[]; }
export interface ConvergeReport {
  domain: string;
  passed: boolean;
  threshold: number;
  pillars: PillarScore[];
  generated_at: string;
}

export interface DesignEvidence {
  bound: boolean;
  handoff_exists: boolean;
  handoff_passed_gate: boolean | null;
  lint_build_passed: boolean | null;
  lint_build_problems: string[];
  fixture_leaks: string[];
  screenshots: string[];
  /** The design gate's own report — the only design evidence that was measured. */
  gate_checks: { id: string; status: 'pass' | 'fail' | 'vacuous'; detail: string }[];
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
  /** Every origin any constitution allowlist cleared, for the egress check. */
  allowedOrigins?: string[];
  approvalAt: string | null;
  dispatchedAt: string | null;
  design?: DesignEvidence;
  threshold?: number;
}

/* Unfinished-work markers. `placeholder` used to be here and had to go: it
   flagged `placeholder={copy.profileForm.skillsHelp}`, which is the HTML input
   attribute, and a comment reading "no component can quietly invent placeholder
   content — ART-08", which is a worker explaining how it COMPLIED with a rule.
   A marker that fires on correct code is not a marker. */
export const PLACEHOLDER = /\b(TODO|FIXME|XXX|HACK|not implemented|unimplemented)\b/;

/** Does this file export the given name? */
export function exportsName(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`export\\s+(?:async\\s+)?(?:default\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${escaped}\\b`).test(source)
    || new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source);
}

/**
 * Paths that appear in a worktree without a worker having authored them.
 *
 * `changedFiles` runs after the gate, so it sees whatever the gate command
 * produced. ui/client's gate is `npm install && npm run build`, which creates
 * node_modules/, dist/ and a lockfile — and the worker was scored 0/50 for
 * "changes stay inside deliverables" because the harness ran that command.
 * An unrelated tool's read logs under .vouch/ cost every other domain 10
 * points the same way.
 *
 * This is the generated-versus-authored line that LINT-33 already draws.
 */
export const NOT_AUTHORED = /(^|\/)(node_modules|dist|build|out|coverage|\.[^/]+)(\/|$)|^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

function changedFiles(worktree: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' });
    return out.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
      .filter((f) => !f.startsWith('.aose/'))
      .filter((f) => !NOT_AUTHORED.test(f));
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
  /* Against the run being scored, not the domain's first run ever. The
     question is whether THIS evidence was produced under an approval; a
     domain that failed once, was re-approved and then passed had answered it,
     and comparing to the first attempt failed it forever. */
  const approvalFirst = Boolean(input.approvalAt && input.dispatchedAt && input.approvalAt <= input.dispatchedAt);

  /* The declaration check in LINT-30 governs the blueprint. This one reads the
     code the worker actually produced, which is where an undeclared host would
     appear. Neither is a runtime sandbox; see docs/HARNESS.md. */
  const allowedOrigins = input.allowedOrigins ?? [];
  const reachedHosts = allowedOrigins.length || task.deliverables.length
    ? [...new Set(task.deliverables.flatMap((file) => undeclaredHosts(read(file) ?? '', allowedOrigins)))]
    : [];

  const riskEvidence: PillarScore = {
    name: 'Risk & evidence',
    score: 0,
    components: [
      { label: 'cited sources verified', earned: cited.length === 0 ? 30 : ratio(verifiedCited.length, cited.length) * 30, possible: 30,
        detail: cited.length ? `${verifiedCited.length}/${cited.length} verified` : 'no citations to verify' },
      { label: 'approval precedes dispatch', earned: approvalFirst ? 25 : 0, possible: 25,
        detail: approvalFirst ? 'approval recorded before the run that produced this evidence' : 'the scored run was dispatched with no approval in force' },
      { label: 'gate evidence produced by harness', earned: input.gateStdoutSha ? 25 : 0, possible: 25,
        detail: input.gateStdoutSha ? `stdout sha256 ${input.gateStdoutSha.slice(0, 12)}` : 'no harness-produced gate hash' },
      { label: 'no undeclared network host in the built code', earned: reachedHosts.length === 0 ? 20 : 0, possible: 20,
        detail: reachedHosts.length ? `reaches ${reachedHosts.slice(0, 3).join(', ')}` : 'none found' },
    ],
  };

  /* ---- Pillar 5: design fidelity (only for a domain bound to a design contract) ----
     Scored from the studio's own artifacts, never from taste: did a human gate
     release this handoff, did lint-build agree the implementation matches the
     frozen tokens, and did any quarantined fixture value survive into the code. */
  const pillars = [specCompliance, testAdequacy, codeQuality, riskEvidence];

  if (input.design?.bound) {
    const design = input.design;
    const designFidelity: PillarScore = {
      name: 'Design fidelity',
      score: 0,
      components: [
        /* The gate carries the most weight because it is the only component
           here that measured anything. A vacuous check earns nothing: it did
           not fail, but it produced no evidence either, and scoring it as a
           pass is how a surface banks credit for a check that never looked. */
        (() => {
          const checks = design.gate_checks ?? [];
          const passed = checks.filter((c) => c.status === 'pass').length;
          const failed = checks.filter((c) => c.status === 'fail');
          const vacuous = checks.filter((c) => c.status === 'vacuous');
          return {
            label: 'the design gate measured and passed',
            earned: checks.length ? Math.round((40 * passed) / checks.length) : 0,
            possible: 40,
            detail: !checks.length ? 'the design gate was never run'
              : failed.length ? `${failed.length} failed: ${failed.map((c) => c.id).join(', ')}`
              : vacuous.length ? `${passed}/${checks.length} passed; ${vacuous.map((c) => c.id).join(', ')} had nothing to inspect`
              : `all ${passed} check(s) passed`,
          };
        })(),
        { label: 'handoff released by a human gate',
          earned: design.handoff_exists && design.handoff_passed_gate === true ? 30 : design.handoff_exists ? 10 : 0,
          possible: 30,
          detail: !design.handoff_exists ? 'no handoff folder'
            : design.handoff_passed_gate === true ? 'gate passed'
            : design.handoff_passed_gate === false ? 'forced export, gate not passed'
            : 'handoff present, gate state unknown' },
        { label: 'implementation matches the frozen contract',
          earned: design.lint_build_passed === true ? 15 : 0, possible: 15,
          detail: design.lint_build_passed === null ? 'lint-build was not run'
            : design.lint_build_passed ? 'lint-build passed'
            : `lint-build reported ${design.lint_build_problems.length} problem(s)` },
        { label: 'no quarantined fixture value shipped',
          earned: design.fixture_leaks.length === 0 ? 15 : 0, possible: 15,
          detail: design.fixture_leaks.length ? `leaked: ${design.fixture_leaks.slice(0, 3).join(', ')}` : 'clean' },
      ],
    };
    pillars.push(designFidelity);
  }
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
