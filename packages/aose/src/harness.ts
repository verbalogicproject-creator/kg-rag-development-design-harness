/**
 * Orchestration: the phases as callable operations over the ledger.
 *
 * This is the layer that makes the workflow a runtime rather than a document.
 * Codex's harness supplied the process spine (capture -> review -> approve ->
 * export); Antigravity supplied the artifacts and the cold-dispatch idea. Both
 * are here, with the phases neither implemented in between.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { Ledger } from './ledger.ts';
import type { ProjectState } from './ledger.ts';
import { apply } from './fsm.ts';
import { compile as compileDir, readTopoOrder } from './compile.ts';
import { lintDir, loadBlueprintDir } from './lint.ts';
import type { LintResult } from './lint.ts';
import { review as reviewProject, approve as approveProject, validate as validateProject } from './review.ts';
import { verify as verifySource } from './research.ts';
import type { FetchLike } from './research.ts';
import { dispatch } from './dispatch.ts';
import type { DispatchResult, SeedFile } from './dispatch.ts';
import { converge as convergeDomain, formatConverge } from './converge.ts';
import type { ConvergeReport } from './converge.ts';
import { buildBlueprint, writeExport, archive as archiveDir } from './export.ts';
import { ConstitutionSchema, IdeaSchema, SourceSchema, safeParse } from './schema.ts';
import { readDesignState, handoffSeed, runStudio, parseLintBuild, resolveStudio } from './design.ts';
import type { DesignState } from './design.ts';
import { collectFixtureValues } from './lint.ts';
import { approvalDigest, worktreeDigest, containedPath, isContained } from './integrity.ts';
import type { Constitution, Idea, Source, Spec, Task, Manifest } from './schema.ts';

export interface HarnessPaths { root: string; workspace: string; blueprints: string; archive: string; db: string; }

export function paths(root = process.cwd()): HarnessPaths {
  const workspace = join(root, '.aose');
  return {
    root,
    workspace,
    blueprints: join(root, 'blueprints'),
    archive: join(root, 'blueprints', '_archive'),
    db: process.env.AOSE_DB ?? join(workspace, 'workspace.sqlite'),
  };
}

export class Harness {
  readonly ledger: Ledger;
  readonly paths: HarnessPaths;

  constructor(root = process.cwd(), ledger?: Ledger) {
    this.paths = paths(root);
    this.ledger = ledger ?? new Ledger(this.paths.db);
  }

  dir(slug: string): string { return join(this.paths.blueprints, slug); }

  /** Where the L.S.Design contract and handoff live for this project. */
  designDir(slug: string): string { return join(this.dir(slug), 'design'); }

  /** Domains that declare a design binding, with their bindings. */
  surfaces(slug: string): { domain: string; contract: string; handoff?: string }[] {
    const artifacts = this.artifacts(slug);
    return Object.entries(artifacts.specs ?? {})
      .filter(([, spec]) => Boolean(spec.design))
      .map(([domain, spec]) => ({ domain, contract: spec.design!.contract, handoff: spec.design!.handoff }));
  }

  designState(slug: string): DesignState { return readDesignState(this.designDir(slug)); }

  /** A stored screen's path as the studio recorded it, for conformance checks. */
  firstStoredScreen(slug: string): string | null {
    const state = join(this.designDir(slug), 'design.json');
    if (!existsSync(state)) return null;
    try {
      const doc = JSON.parse(readFileSync(state, 'utf8')) as { screens?: { files?: { html?: string } }[] };
      const html = (doc.screens ?? []).map((screen) => screen.files?.html).find(Boolean);
      return html ?? null;
    } catch { return null; }
  }

  /** The design gate's last report, if it has been run. Absent is not a pass. */
  designGateChecks(slug: string): { id: string; status: 'pass' | 'fail' | 'vacuous'; detail: string }[] {
    const report = join(this.designDir(slug), '__checks__', 'tokens.report.json');
    if (!existsSync(report)) return [];
    try {
      const parsed = JSON.parse(readFileSync(report, 'utf8'));
      return Array.isArray(parsed?.checks)
        ? parsed.checks.map((c: { id: string; status: string; detail: string }) =>
            ({ id: c.id, status: c.status as 'pass' | 'fail' | 'vacuous', detail: c.detail }))
        : [];
    } catch { return []; }
  }

  /** Scaffold design/DESIGN.md, tokens and preview through the studio CLI. */
  designInit(slug: string, name?: string): { ok: boolean; command: string; output: string } {
    const dir = this.dir(slug);
    mkdirSync(dir, { recursive: true });
    const idea = this.ledger.latest<Idea>(slug, 'idea');
    const args = ['init', '--project', dir, '--name', name ?? idea?.idea.title ?? slug];
    const result = runStudio(args, { cwd: this.paths.root });
    this.ledger.addRevision(slug, 'design_init', { ok: result.ok, command: result.command, status: result.status });
    if (result.ok) this.noteEdit(slug);
    return { ok: result.ok, command: result.command, output: `${result.stdout}${result.stderr}`.trim() };
  }

  /** Export the handoff. The studio refuses unless every screen is approved. */
  designHandoff(slug: string, options: { force?: boolean } = {}): { ok: boolean; command: string; output: string; state: DesignState } {
    const args = ['handoff', '--project', this.dir(slug)];
    if (options.force) args.push('--force');
    const result = runStudio(args, { cwd: this.paths.root });
    const state = this.designState(slug);
    this.ledger.addRevision(slug, 'design_handoff', { ok: result.ok, forced: Boolean(options.force), state });
    /* A new handoff is new approved-surface content, so any standing approval
       no longer covers what would be dispatched. */
    if (result.ok) this.noteEdit(slug);
    return { ok: result.ok, command: result.command, output: `${result.stdout}${result.stderr}`.trim(), state };
  }

  /** Run lint-build against a running preview of the implemented surface. */
  /**
   * Run lint-build for one surface and record the result against that surface.
   *
   * Evidence is bound to the domain, the URL, the handoff digest and the
   * digest of the files it was run over. Convergence only consumes evidence
   * whose bindings match the run it is scoring, so a passing lint of some
   * other preview cannot be spent on a different domain's score.
   */
  designLintBuild(slug: string, domain: string, url: string, options: { cwd?: string; worktree?: string } = {}):
    { passed: boolean; problems: string[]; command: string; domain: string } {
    const result = runStudio(['lint-build', '--project', this.dir(slug), '--url', url], { cwd: options.cwd ?? this.paths.root });
    const parsed = parseLintBuild(result);
    const deliverables = this.artifacts(slug).tasks?.[domain]?.task.deliverables ?? [];
    this.ledger.addRevision(slug, 'design_lint_build', {
      ...parsed,
      domain,
      url,
      handoff_digest: this.designState(slug).handoff_digest,
      worktree_digest: options.worktree ? worktreeDigest(options.worktree, deliverables) : '',
      at: new Date().toISOString(),
    });
    return { ...parsed, command: result.command, domain };
  }

  studioCommand(slug: string): string {
    const studio = resolveStudio();
    return `${studio.cmd} ${[...studio.args, '--project', this.dir(slug), '--open'].join(' ')}`;
  }

  private requireProject(slug: string) {
    const project = this.ledger.getProject(slug);
    if (!project) throw new Error(`Unknown project "${slug}". Run: aose init ${slug}`);
    return project;
  }

  private noteEdit(slug: string): void {
    this.ledger.addRevision(slug, 'artifact_edit', { at: new Date().toISOString() });
    this.ledger.supersedeApprovals(slug);
  }

  /**
   * A digest of everything the approval covers: blueprint artifacts, every
   * spec and task, the design contract and the frozen handoff. Approving
   * records it and dispatching recomputes it, so an edit invalidates the
   * approval whether or not the harness was what made the edit.
   */
  approvalDigest(slug: string): string {
    const artifacts = this.artifacts(slug);
    const extra: string[] = [];
    for (const boundary of artifacts.manifest?.system.boundaries ?? []) {
      extra.push(boundary.spec, boundary.task);
    }
    return approvalDigest(this.dir(slug), extra, this.designDir(slug)).value;
  }

  init(slug: string): ProjectState {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Slug must use lowercase letters, numbers and hyphens.');
    if (this.ledger.getProject(slug)) throw new Error(`Project "${slug}" already exists.`);
    mkdirSync(this.dir(slug), { recursive: true });
    this.ledger.createProject(slug);
    return 'IDEA_DRAFT';
  }

  /** Load constitution + idea from the blueprint directory into the ledger. */
  capture(slug: string): { idea: Idea; constitution: Constitution } {
    this.requireProject(slug);
    const dir = this.dir(slug);
    const constitution = readArtifact<Constitution>(join(dir, 'constitution.yaml'), ConstitutionSchema, 'constitution');
    const idea = readArtifact<Idea>(join(dir, 'idea.yaml'), IdeaSchema, 'idea');
    const revision = this.ledger.addRevision(slug, 'idea', idea);
    this.ledger.addRevision(slug, 'constitution', constitution);
    this.noteEdit(slug);
    apply(this.ledger, slug, 'capture', revision);
    return { idea, constitution };
  }

  ready(slug: string): void {
    this.requireProject(slug);
    const idea = this.ledger.latest<Idea>(slug, 'idea');
    if (!idea) throw new Error('Capture an idea before marking it ready.');
    if (idea.idea.open_questions.length) {
      throw new Error(`Cannot mark ready: ${idea.idea.open_questions.length} open question(s) remain. Resolve them in idea.yaml, then re-run capture.`);
    }
    apply(this.ledger, slug, 'ready', this.ledger.latestRevisionId(slug, 'idea') ?? null);
  }

  addSource(slug: string, input: unknown): Source {
    this.requireProject(slug);
    const parsed = safeParse<Source>(SourceSchema as never, input);
    if (!parsed.ok) throw new Error(`Invalid source: ${parsed.errors.join('; ')}`);
    this.ledger.upsertSource(slug, parsed.value as unknown as { url: string } & Record<string, unknown>);
    this.writeSourcesFile(slug);
    const project = this.requireProject(slug);
    if (['IDEA_READY', 'COMPILED', 'LINTED'].includes(project.state)) apply(this.ledger, slug, 'research', null);
    return parsed.value;
  }

  async verifySources(slug: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike):
    Promise<{ url: string; status: string; detail: string }[]> {
    this.requireProject(slug);
    const results: { url: string; status: string; detail: string }[] = [];
    for (const source of this.ledger.sources<Source>(slug)) {
      const outcome = await verifySource(source, fetchImpl);
      this.ledger.upsertSource(slug, { ...source, verified: outcome } as unknown as { url: string } & Record<string, unknown>);
      results.push({ url: source.url, status: outcome.status, detail: outcome.detail });
    }
    this.writeSourcesFile(slug);
    this.ledger.addRevision(slug, 'research_verify', results);
    return results;
  }

  /** Mirror the ledger's sources into the blueprint dir so the directory is
   *  self-describing and `aose lint --dir` can check citations without a db. */
  private writeSourcesFile(slug: string): void {
    const sources = this.ledger.sources<Source>(slug);
    const dir = this.dir(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sources.yaml'),
      '# Research ledger, mirrored from the harness database by aose.\n' +
      '# verified.status is written only by `aose research-verify`.\n' +
      YAML.stringify({ sources }));
  }

  compile(slug: string) {
    this.requireProject(slug);
    const result = compileDir(this.dir(slug));
    const revision = this.ledger.addRevision(slug, 'compile', result);
    if (result.ok) {
      this.noteEdit(slug);
      this.ledger.supersedeApprovals(slug);
      apply(this.ledger, slug, 'compile', revision);
    } else {
      this.ledger.addFinding(slug, 'compile', result.errors);
    }
    return result;
  }

  lint(slug: string): LintResult {
    this.requireProject(slug);
    const result = lintDir(this.dir(slug), { sources: this.ledger.sources<Source>(slug) });
    const revision = this.ledger.addRevision(slug, 'lint', result);
    if (result.ok) apply(this.ledger, slug, 'lint', revision);
    else this.ledger.addFinding(slug, 'lint', result.errors);
    return result;
  }

  /**
   * One review covers both planes.
   *
   * A surface domain bound to a design contract cannot pass review until the
   * studio's own gate would pass, so the person approves the logic plan and the
   * visual direction once rather than twice, and a later edit to either one
   * supersedes the same approval.
   */
  review(slug: string) {
    this.requireProject(slug);
    const result = reviewProject(this.ledger, slug, this.dir(slug));
    const findings = [...result.findings];

    for (const surface of this.surfaces(slug)) {
      const state = this.designState(slug);
      if (!state.gate_can_pass && state.handoff_passed_gate !== true) {
        for (const blocker of state.blockers) {
          findings.push({ id: 'LINT-28', severity: 'error', where: `design (${surface.domain})`, message: blocker });
        }
        if (!state.blockers.length) {
          findings.push({ id: 'LINT-28', severity: 'error', where: `design (${surface.domain})`, message: 'The design gate has not passed and no handoff was released.' });
        }
      }
    }

    const merged = { passed: findings.length === 0, findings, warnings: result.warnings };
    if (merged.passed !== result.passed) this.ledger.addRevision(slug, 'review', merged);
    if (merged.passed) apply(this.ledger, slug, 'review', this.ledger.latestRevisionId(slug, 'review') ?? null);
    else this.ledger.addFinding(slug, 'review', findings);
    return merged;
  }

  approve(slug: string, by: string) {
    this.requireProject(slug);
    const result = this.review(slug);
    if (!result.passed) return result;
    this.ledger.addApproval(slug, by, this.approvalDigest(slug));
    apply(this.ledger, slug, 'approve', this.ledger.latestRevisionId(slug, 'review') ?? null);
    return result;
  }

  artifacts(slug: string) {
    const { input } = loadBlueprintDir(this.dir(slug));
    return input;
  }

  async dispatch(slug: string, options: {
    domain?: string; adapter?: string; dryRun?: boolean; fixtureRoot?: string;
    maxAttempts?: number; timeoutMinutes?: number; bypassSandbox?: boolean;
    onEvent?: (message: string) => void;
  } = {}): Promise<DispatchResult[]> {
    const project = this.requireProject(slug);
    const dir = this.dir(slug);
    const artifacts = this.artifacts(slug);
    if (!artifacts.manifest) throw new Error('No usable system manifest; run "aose compile" first.');

    if (!options.dryRun) {
      if (project.state !== 'APPROVED' && project.state !== 'DISPATCHED' && project.state !== 'GATED') {
        throw new Error(`Dispatch requires an approved blueprint. Current state: ${project.state}.`);
      }
      const approval = this.ledger.activeApproval(slug);
      if (!approval) {
        throw new Error('Dispatch requires an active approval. The blueprint changed after it was approved; re-run review and approve.');
      }
      const current = this.approvalDigest(slug);
      if (approval.digest && approval.digest !== current) {
        this.ledger.supersedeApprovals(slug);
        throw new Error(`Dispatch refused: what is on disk no longer matches what was approved (approved ${approval.digest.slice(0, 12)}, found ${current.slice(0, 12)}). Re-run review and approve.`);
      }
      if (!approval.digest) {
        throw new Error('Dispatch refused: the recorded approval carries no content digest, so it cannot be shown to cover the current blueprint. Re-run approve.');
      }
    }

    const order = readTopoOrder(dir);
    const domains = options.domain ? [options.domain] : (order.length ? order : Object.keys(artifacts.specs ?? {}));
    const adapter = options.adapter ?? 'fake';
    const results: DispatchResult[] = [];

    for (const domain of domains) {
      const spec = artifacts.specs?.[domain];
      const task = artifacts.tasks?.[domain]?.task;
      if (!spec || !task) throw new Error(`No compiled spec/task for domain "${domain}".`);

      const boundary = artifacts.manifest.system.boundaries.find((b) => b.domain === domain);
      for (const upstream of boundary?.depends_on ?? []) {
        if (!options.dryRun && !this.ledger.domainPassed(slug, upstream)) {
          throw new Error(`Domain "${domain}" depends on "${upstream}", which has not passed its gate yet. Dispatch in topological order.`);
        }
      }

      const seed = this.seedFor(slug, artifacts, domain);
      if (!options.dryRun) apply(this.ledger, slug, 'dispatch', null);

      const result = await dispatch(this.ledger, {
        slug, domain, adapter,
        workspaceRoot: this.paths.workspace,
        repoRoot: this.paths.root,
        spec, task,
        constitution: artifacts.constitution,
        maxAttempts: options.maxAttempts,
        timeoutMinutes: options.timeoutMinutes,
        fixtureRoot: options.fixtureRoot,
        seed,
        dryRun: options.dryRun,
        adapterOptions: { bypassSandbox: options.bypassSandbox },
        onEvent: options.onEvent,
      });
      results.push(result);

      if (!options.dryRun) {
        if (result.passed) {
          const allPassed = (order.length ? order : domains).every((d) => this.ledger.domainPassed(slug, d));
          apply(this.ledger, slug, allPassed ? 'gate_pass' : 'gate_partial', null);
        } else {
          apply(this.ledger, slug, 'gate_fail', null);
          apply(this.ledger, slug, 'exhausted', null);
          break;
        }
      }
    }
    return results;
  }

  /**
   * What a cold worker legitimately starts with: the deliverables of the
   * domains it depends on (import-only), plus a minimal package manifest so a
   * test runner can start. Nothing else from the project reaches it.
   */
  private seedFor(slug: string, artifacts: ReturnType<Harness['artifacts']>, domain: string): SeedFile[] {
    const boundary = artifacts.manifest?.system.boundaries.find((b) => b.domain === domain);
    const ownDeliverables = artifacts.tasks?.[domain]?.task.deliverables ?? [];
    const seed: SeedFile[] = [];

    /* A minimal manifest so a test runner can start, unless the domain owns its
       own package.json, in which case seeding one would fight the worker for
       the same file. */
    if (!ownDeliverables.includes('package.json')) {
      seed.push({ path: 'package.json', content: `${JSON.stringify({ name: `aose-${domain.replace(/\//g, '-')}`, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n` });
    }
    const design = artifacts.specs?.[domain]?.design;
    if (design?.handoff) {
      /* handoffSeed refuses a path that escapes the design root; a blueprint
         that declares one is a blueprint that does not get dispatched. */
      for (const file of handoffSeed(this.dir(slug), design.handoff)) seed.push(file);
    }

    for (const upstream of boundary?.depends_on ?? []) {
      const passing = this.ledger.runs(slug, upstream).filter((r) => r.gate_exit === 0).pop();
      const upstreamTask = artifacts.tasks?.[upstream]?.task;
      if (!passing || !upstreamTask) continue;
      const from = join(this.paths.workspace, 'worktrees', slug, `${upstream.replace(/\//g, '-')}-${passing.adapter}-a${passing.attempt}`);
      for (const file of upstreamTask.deliverables) {
        if (file === 'package.json') continue;
        seed.push({ path: file, from: join(from, file) });
      }
    }
    return seed;
  }

  converge(slug: string): { reports: ConvergeReport[]; passed: boolean } {
    this.requireProject(slug);
    const artifacts = this.artifacts(slug);
    const sources = this.ledger.sources<Source>(slug);
    const citedUrls = [...new Set((artifacts.manifest?.decisions ?? []).flatMap((d) => d.sources))];
    const approval = this.ledger.activeApproval(slug);
    const runs = this.ledger.runs(slug);
    const firstDispatchAt = runs.length ? runs[0].started_at : null;

    const reports: ConvergeReport[] = [];
    for (const [domain, spec] of Object.entries(artifacts.specs ?? {})) {
      const task = artifacts.tasks?.[domain]?.task;
      if (!task) continue;
      const passing = runs.filter((r) => r.domain === domain && r.gate_exit === 0).pop();
      if (!passing) {
        reports.push({
          domain, passed: false, threshold: 70, generated_at: new Date().toISOString(),
          pillars: [{ name: 'Test adequacy', score: 0, components: [{ label: 'gate exit 0', earned: 0, possible: 60, detail: 'no passing gate run recorded' }] }],
        });
        continue;
      }
      const gateLog = join(passing.run_dir, 'gate.log');
      const stdout = existsSync(gateLog) ? readFileSync(gateLog, 'utf8') : '';
      const worktree = join(this.paths.workspace, 'worktrees', slug, `${domain.replace(/\//g, '-')}-${passing.adapter}-a${passing.attempt}`);
      reports.push(convergeDomain({
        domain, worktree, spec, task,
        gateExit: passing.gate_exit, gateStdout: stdout, gateStdoutSha: passing.gate_stdout_sha256,
        sources, citedUrls,
        allowedOrigins: (artifacts.constitution?.constitution.allowlists ?? []).flatMap((list) => list.entries),
        approvalAt: approval?.created_at ?? null,
        firstDispatchAt,
        design: this.designEvidence(slug, domain, worktree),
      }));
    }

    const passed = reports.length > 0 && reports.every((r) => r.passed);
    const revision = this.ledger.addRevision(slug, 'converge', reports);
    apply(this.ledger, slug, passed ? 'converge' : 'converge_fail', revision);
    if (!passed) this.ledger.addFinding(slug, 'converge', reports.filter((r) => !r.passed));
    return { reports, passed };
  }

  /** What the design plane can prove about one domain, read from real artifacts. */
  private designEvidence(slug: string, domain: string, worktree: string) {
    const spec = this.artifacts(slug).specs?.[domain];
    if (!spec?.design) {
      return { bound: false, handoff_exists: false, handoff_passed_gate: null, lint_build_passed: null, lint_build_problems: [], fixture_leaks: [], screenshots: [], gate_checks: [] };
    }
    const state = this.designState(slug);
    const deliverables = this.artifacts(slug).tasks?.[domain]?.task.deliverables ?? [];
    const runDigest = worktreeDigest(worktree, deliverables);

    /* Only evidence produced for THIS domain, against THIS handoff, over THESE
       files counts. A lint of another surface or of an earlier build is not
       evidence about this one. */
    const lint = this.ledger.all<{ passed: boolean; problems: string[]; domain?: string; handoff_digest?: string; worktree_digest?: string }>(slug, 'design_lint_build')
      .filter((row) => row.domain === domain
        && (row.handoff_digest ?? '') === state.handoff_digest
        && (row.worktree_digest ?? '') === runDigest)
      .pop();

    const handoffRel = spec.design.handoff ?? 'design/handoff';
    if (!isContained(this.dir(slug), handoffRel)) {
      return { bound: true, handoff_exists: false, handoff_passed_gate: false, lint_build_passed: false,
        lint_build_problems: [`design.handoff "${handoffRel}" resolves outside the project`], fixture_leaks: [], screenshots: [], gate_checks: [] };
    }
    const fixtures = join(containedPath(this.dir(slug), handoffRel), 'fixtures');
    const quarantined = existsSync(fixtures) ? collectFixtureValues(fixtures) : [];
    const leaks: string[] = [];
    for (const deliverable of deliverables) {
      const path = join(worktree, deliverable);
      if (!existsSync(path)) continue;
      const body = readFileSync(path, 'utf8');
      for (const value of quarantined) if (body.includes(value) && !leaks.includes(value)) leaks.push(value);
    }
    return {
      bound: true,
      handoff_exists: state.handoff_exists,
      handoff_passed_gate: state.handoff_passed_gate,
      lint_build_passed: lint ? lint.passed : null,
      lint_build_problems: lint?.problems ?? [],
      fixture_leaks: leaks,
      screenshots: [],
      /* Read from the gate's own report rather than re-run here: converge
         scores evidence that was produced, it does not produce it. */
      gate_checks: this.designGateChecks(slug),
    };
  }

  export(slug: string): string[] {
    this.requireProject(slug);
    const artifacts = this.artifacts(slug);
    const constitution = artifacts.constitution ?? this.ledger.latest<Constitution>(slug, 'constitution');
    const idea = artifacts.idea ?? this.ledger.latest<Idea>(slug, 'idea');
    if (!constitution || !idea || !artifacts.manifest) throw new Error('Cannot export: constitution, idea and manifest are all required.');

    const blueprint = buildBlueprint({
      slug, constitution, idea,
      manifest: artifacts.manifest as Manifest,
      specs: artifacts.specs as Record<string, Spec>,
      tasks: artifacts.tasks as Record<string, Task>,
      sources: this.ledger.sources<Source>(slug),
      topoOrder: readTopoOrder(this.dir(slug)),
    });
    const written = writeExport(this.dir(slug), blueprint);
    const revision = this.ledger.addRevision(slug, 'blueprint', blueprint);
    apply(this.ledger, slug, 'export', revision);
    return written;
  }

  archive(slug: string): string {
    this.requireProject(slug);
    const target = archiveDir(this.dir(slug), this.paths.archive, slug);
    apply(this.ledger, slug, 'archive', null);
    return target;
  }

  /**
   * Return a blocked project to COMPILED, consuming one respec allowance.
   *
   * The constitution declares max_respec and nothing was enforcing it, so a
   * caller could cycle blocked -> respec -> dispatch forever. The allowance is
   * consumed here before the transition, and a spent allowance is a stop.
   */
  respec(slug: string, reason: string): { allowed: boolean; used: number; remaining: number; state: ProjectState } {
    const project = this.requireProject(slug);
    const constitution = this.artifacts(slug).constitution ?? this.ledger.latest<Constitution>(slug, 'constitution');
    const maxRespec = constitution?.constitution.budgets.max_respec ?? 2;
    const outcome = this.ledger.consumeRespec(slug, maxRespec);
    if (!outcome.allowed) {
      this.ledger.addFinding(slug, 'respec', { reason, exhausted: true, used: outcome.used, max: maxRespec });
      return { ...outcome, state: project.state };
    }
    const revision = this.ledger.addRevision(slug, 'respec', { reason, used: outcome.used, max: maxRespec });
    const state = apply(this.ledger, slug, 'respec', revision);
    this.noteEdit(slug);
    return { ...outcome, state };
  }

  validate(slug: string) { return validateProject(this.ledger, slug, this.dir(slug)); }

  status(slug: string) {
    const project = this.requireProject(slug);
    return {
      slug,
      state: project.state,
      respec_count: project.respec_count,
      approval: this.ledger.activeApproval(slug) ?? null,
      sources: this.ledger.sources<Source>(slug).map((s) => ({ url: s.url, status: s.verified.status })),
      runs: this.ledger.runs(slug).map((r) => ({ domain: r.domain, adapter: r.adapter, attempt: r.attempt, gate_exit: r.gate_exit })),
      transitions: this.ledger.transitions(slug).length,
    };
  }

  close(): void { this.ledger.close(); }
}

function readArtifact<T>(path: string, schema: unknown, label: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  const parsed = safeParse<T>(schema as never, YAML.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`Invalid ${label} (${path}): ${parsed.errors.join('; ')}`);
  return parsed.value;
}

export { formatConverge };
