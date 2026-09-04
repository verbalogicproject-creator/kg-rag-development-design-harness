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

  private requireProject(slug: string) {
    const project = this.ledger.getProject(slug);
    if (!project) throw new Error(`Unknown project "${slug}". Run: aose init ${slug}`);
    return project;
  }

  private noteEdit(slug: string): void {
    this.ledger.addRevision(slug, 'artifact_edit', { at: new Date().toISOString() });
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

  review(slug: string) {
    this.requireProject(slug);
    const result = reviewProject(this.ledger, slug, this.dir(slug));
    if (result.passed) apply(this.ledger, slug, 'review', this.ledger.latestRevisionId(slug, 'review') ?? null);
    return result;
  }

  approve(slug: string, by: string) {
    this.requireProject(slug);
    const result = approveProject(this.ledger, slug, this.dir(slug), by);
    if (result.passed) apply(this.ledger, slug, 'approve', this.ledger.latestRevisionId(slug, 'review') ?? null);
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
      if (!this.ledger.activeApproval(slug)) {
        throw new Error('Dispatch requires an active approval. The blueprint changed after it was approved; re-run review and approve.');
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
    const seed: SeedFile[] = [{ path: 'package.json', content: `${JSON.stringify({ name: `aose-${domain.replace(/\//g, '-')}`, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n` }];
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
        approvalAt: approval?.created_at ?? null,
        firstDispatchAt,
      }));
    }

    const passed = reports.length > 0 && reports.every((r) => r.passed);
    const revision = this.ledger.addRevision(slug, 'converge', reports);
    apply(this.ledger, slug, passed ? 'converge' : 'converge_fail', revision);
    if (!passed) this.ledger.addFinding(slug, 'converge', reports.filter((r) => !r.passed));
    return { reports, passed };
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
