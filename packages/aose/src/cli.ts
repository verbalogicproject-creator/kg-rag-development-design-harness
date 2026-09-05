#!/usr/bin/env node
/**
 * aose — the AOSE v2 command line.
 *
 * Every phase of the lifecycle is a subcommand, and every subcommand either
 * advances the recorded state or refuses with a reason. Nothing here decides
 * anything a human should decide: approval is a command a person runs.
 */
import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import YAML from 'yaml';
import { Harness } from './harness.ts';
import { lintDir } from './lint.ts';
import { formatConverge } from './converge.ts';
import { designCheck, formatReport, loadDesignSystem } from './designcheck.ts';
import { checkFocusVisible, checkReducedMotion } from './designbrowser.ts';
import { ADAPTERS } from './adapters/index.ts';

const USAGE = `aose — Agent-Oriented Software Engineering harness v2

  Lifecycle
    init <slug>                    Create a project and its blueprint directory
    capture <slug>                 Load constitution.yaml + idea.yaml into the ledger
    ready <slug>                   Declare the idea free of open questions
    research-add <slug> --file F   Record a research source
    research-verify <slug>         Fetch every source and check it says what was claimed
    compile <slug>                 Normalize the triad, derive upstream exports and build order
    lint <slug|--dir D>            Run LINT-01..30 over a blueprint
    review <slug>                  Machine review: lint clean, citations verified
    approve <slug> --by NAME       Record a human approval
    dispatch <slug> [options]      Cold-dispatch domains to a worker, then run their gates
    converge <slug>                Score the pillars against produced evidence (five for a design-bound surface)
    export <slug>                  Write blueprint.yaml + implementation-plan.md
    archive <slug>                 Copy the finished blueprint into blueprints/_archive
    respec <slug> --reason R       Return a blocked project to compile, spending one respec allowance
    validate <slug>                Replay the transition log and audit approvals
    status <slug>                  Show current state, sources, runs

  Design plane (L.S.Design)
    design-init <slug>             Scaffold design/DESIGN.md, tokens and preview
    design-studio <slug>           Print the command that opens the studio for review
    design-status <slug>           Screens, decisions, gate state and blockers
    design-handoff <slug>          Export the frozen handoff (the studio gates this)
    design-check <slug>            Run the design gate: tokens on scale, contrast in both modes
    design-lint <slug> --domain D --url U
                                   Check a built surface against the frozen contract

  Dispatch options
    --domain D        Only this domain (default: every domain in build order)
    --adapter A       ${Object.keys(ADAPTERS).join(' | ')}   (default: fake)
    --fixture DIR     Fixture root for the offline fake worker
    --dry-run         Build payloads and print command lines; spawn nothing
    --attempts N      Override the attempt bound
    --timeout N       Per-attempt timeout in minutes
    --bypass-sandbox  Codex only: skip the landlock sandbox (PRoot fallback)

  Global
    --root DIR        Workspace root (default: cwd)
    --json            Machine-readable output
    --force           design-handoff only: export without the gate (stamped provisional)
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    root: { type: 'string' }, dir: { type: 'string' }, file: { type: 'string' },
    by: { type: 'string' }, domain: { type: 'string' }, adapter: { type: 'string' }, reason: { type: 'string' },
    fixture: { type: 'string' }, attempts: { type: 'string' }, timeout: { type: 'string' },
    adapters: { type: 'string' },
    url: { type: 'string' }, name: { type: 'string' }, force: { type: 'boolean' },
    'dry-run': { type: 'boolean' }, 'bypass-sandbox': { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean' },
  },
});

const command = positionals[0];
const slug = positionals[1];
const json = Boolean(values.json);
const root = resolve((values.root as string) ?? process.cwd());

if (!command || values.help || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const out = (label: string, data: unknown): void => {
  if (json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${label}\n`);
};

function readYamlFile(path: string): unknown {
  if (!existsSync(path)) fail(`No such file: ${path}`);
  return YAML.parse(readFileSync(path, 'utf8'));
}

/* `lint --dir` works with no project and no database, so a Codex or Gemini
   user can validate a blueprint with `npx aose lint --dir ./blueprint`. */
if (command === 'lint' && (values.dir || (slug && existsSync(resolve(slug, 'system.manifest.yaml'))))) {
  const dir = resolve((values.dir as string) ?? slug);
  const result = lintDir(dir);
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const finding of result.errors) process.stdout.write(`  error  ${finding.id}  ${finding.where}: ${finding.message}\n`);
    for (const finding of result.warnings) process.stdout.write(`  warn   ${finding.id}  ${finding.where}: ${finding.message}\n`);
    process.stdout.write(result.ok
      ? `\nPASS — 0 errors, ${result.warnings.length} warning(s)\n`
      : `\nFAIL — ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (!slug) fail(`Command "${command}" needs a project slug.\n\n${USAGE}`);

const harness = new Harness(root);

try {
  switch (command) {
    case 'init': {
      harness.init(slug);
      out(`Initialized "${slug}" at ${harness.dir(slug)} (state IDEA_DRAFT).`, { slug, state: 'IDEA_DRAFT', dir: harness.dir(slug) });
      break;
    }
    case 'capture': {
      const { idea } = harness.capture(slug);
      out(`Captured "${idea.idea.title}" (scope ${idea.idea.scope_class}, seeded by ${idea.idea.seed_author}).`, idea);
      break;
    }
    case 'ready': {
      harness.ready(slug);
      out(`"${slug}" is IDEA_READY.`, harness.status(slug));
      break;
    }
    case 'research-add': {
      if (!values.file) fail('research-add needs --file <source.yaml>');
      const source = harness.addSource(slug, readYamlFile(resolve(values.file as string)));
      out(`Recorded source ${source.url} (unverified until you run research-verify).`, source);
      break;
    }
    case 'research-verify': {
      const results = await harness.verifySources(slug);
      if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      else for (const r of results) process.stdout.write(`  ${r.status.padEnd(11)} ${r.url}\n    ${r.detail}\n`);
      const bad = results.filter((r) => r.status !== 'verified');
      if (!json) process.stdout.write(bad.length ? `\n${bad.length} source(s) did not verify.\n` : `\nAll ${results.length} source(s) verified.\n`);
      process.exitCode = bad.length ? 1 : 0;
      break;
    }
    case 'compile': {
      const result = harness.compile(slug);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.ok) process.stdout.write(`Compiled. Build order: ${result.topo_order.join(' -> ')}\n${result.written.length} file(s) normalized.\n`);
      else for (const error of result.errors) process.stdout.write(`  error  ${error}\n`);
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case 'lint': {
      const result = harness.lint(slug);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        for (const finding of result.errors) process.stdout.write(`  error  ${finding.id}  ${finding.where}: ${finding.message}\n`);
        for (const finding of result.warnings) process.stdout.write(`  warn   ${finding.id}  ${finding.where}: ${finding.message}\n`);
        process.stdout.write(result.ok ? `\nPASS — 0 errors, ${result.warnings.length} warning(s)\n` : `\nFAIL — ${result.errors.length} error(s)\n`);
      }
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case 'design-check': {
      // The design plane's execution_gate. Writes its report beside the
      // contract so converge can read evidence rather than a claim.
      const dir = harness.dir(slug);
      // Surfaces come from the spec that binds the contract, so the gate checks
      // the states the domain actually declared rather than a default guess.
      const report = designCheck(dir, harness.surfaces(slug).flatMap((surface) => {
        const spec = harness.artifacts(slug).specs?.[surface.domain];
        return (spec?.design?.surfaces ?? []).map((entry: unknown) =>
          typeof entry === 'string' ? { id: entry } : entry as { id: string; states?: string[] });
      }));
      // The browser checks run alongside the pure ones and fold into the same
      // report, so converge reads one artifact rather than two.
      const system = loadDesignSystem(dir);
      const surfaces = harness.surfaces(slug).flatMap((surface) => {
        const spec = harness.artifacts(slug).specs?.[surface.domain];
        return (spec?.design?.surfaces ?? []).map((entry: unknown) =>
          typeof entry === 'string' ? { id: entry } : entry as { id: string; states?: string[] });
      });
      report.checks.push(checkFocusVisible(system, dir, surfaces), checkReducedMotion(system, dir, surfaces));
      report.ok = report.checks.every((check) => check.status !== 'fail');

      const out = join(dir, 'design', '__checks__');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'tokens.report.json'), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
      process.exitCode = report.ok ? 0 : 1;
      break;
    }
    case 'review': {
      const result = harness.review(slug);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        for (const finding of result.findings) process.stdout.write(`  blocker  ${finding.id}  ${finding.where}: ${finding.message}\n`);
        process.stdout.write(result.passed ? '\nReview passed. A human may now approve.\n' : `\nReview failed with ${result.findings.length} blocker(s).\n`);
      }
      process.exitCode = result.passed ? 0 : 1;
      break;
    }
    case 'approve': {
      if (!values.by) fail('approve needs --by "<name>" — an approval must name a person.');
      const result = harness.approve(slug, values.by as string);
      if (!result.passed) {
        for (const finding of result.findings) process.stdout.write(`  blocker  ${finding.id}  ${finding.where}: ${finding.message}\n`);
        fail('\nCannot approve while review has blockers.');
      }
      out(`Approved by ${values.by}.`, harness.status(slug));
      break;
    }
    case 'dispatch': {
      const results = await harness.dispatch(slug, {
        domain: values.domain as string | undefined,
        adapter: (values.adapter as string) ?? 'fake',
        dryRun: Boolean(values['dry-run']),
        fixtureRoot: values.fixture as string | undefined,
        maxAttempts: values.attempts ? Number(values.attempts) : undefined,
        timeoutMinutes: values.timeout ? Number(values.timeout) : undefined,
        bypassSandbox: Boolean(values['bypass-sandbox']),
        onEvent: (message) => { if (!json) process.stdout.write(`${message}\n`); },
      });
      if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      else for (const result of results) {
        process.stdout.write(`\n${result.domain} via ${result.adapter}: ${result.passed ? 'GATE PASS' : values['dry-run'] ? 'dry run' : 'GATE FAIL'}\n`);
        process.stdout.write(`  ${result.command_preview}\n`);
      }
      process.exitCode = results.every((r) => r.passed) || values['dry-run'] ? 0 : 1;
      break;
    }
    case 'converge': {
      const { reports, passed } = harness.converge(slug);
      if (json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
      else for (const report of reports) process.stdout.write(`${formatConverge(report)}\n\n`);
      process.exitCode = passed ? 0 : 1;
      break;
    }
    case 'export': {
      const written = harness.export(slug);
      out(`Exported:\n  ${written.join('\n  ')}`, { written });
      break;
    }
    case 'archive': {
      const target = harness.archive(slug);
      out(`Archived to ${target}`, { target });
      break;
    }
    case 'respec': {
      if (!values.reason) fail('respec needs --reason "<why the plan is changing>".');
      const outcome = harness.respec(slug, values.reason as string);
      if (json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      else if (outcome.allowed) process.stdout.write(`Respec ${outcome.used} of ${outcome.used + outcome.remaining}. State is now ${outcome.state}. Edit the blueprint, then compile, lint, review and approve again.\n`);
      else process.stdout.write(`Respec refused: the constitution's respec allowance is spent after ${outcome.used} attempt(s). This plan is not converging; change the approach rather than retrying it.\n`);
      process.exitCode = outcome.allowed ? 0 : 1;
      break;
    }
    case 'validate': {
      const report = harness.validate(slug);
      if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        for (const error of report.errors) process.stdout.write(`  error  ${error}\n`);
        process.stdout.write(report.valid ? `\nVALID — state ${report.state}, transition log replays cleanly.\n` : `\nINVALID — ${report.errors.length} problem(s).\n`);
      }
      process.exitCode = report.valid ? 0 : 1;
      break;
    }
    case 'design-init': {
      const result = harness.designInit(slug, values.name as string | undefined);
      if (!json) process.stdout.write(`${result.output}\n`);
      out(result.ok ? `Design contract scaffolded in ${harness.designDir(slug)}.\nEdit it, or run the ls-design-contract skill to fill it in properly.` : 'Studio init failed.', result);
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case 'design-studio': {
      const command = harness.studioCommand(slug);
      out(`Open the studio with:\n  ${command}\n\nApprove or reject each screen there. The handoff is released only when every screen is approved.`, { command });
      break;
    }
    case 'design-status': {
      const state = harness.designState(slug);
      if (json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      else {
        process.stdout.write(`design: ${state.root}\n`);
        process.stdout.write(`  contract ${state.contract_exists ? 'present' : 'missing'}, tokens ${state.tokens_exists ? 'present' : 'missing'}, preview ${state.preview_exists ? 'present' : 'missing'}\n`);
        process.stdout.write(`  screens  ${state.approved_screens}/${state.total_screens} approved\n`);
        process.stdout.write(`  handoff  ${state.handoff_exists ? (state.handoff_passed_gate === false ? 'present (forced, gate not passed)' : 'present') : 'not exported'}\n`);
        for (const blocker of state.blockers) process.stdout.write(`  blocker: ${blocker}\n`);
        process.stdout.write(state.gate_can_pass ? '\nThe design gate can pass.\n' : '\nThe design gate cannot pass yet.\n');
      }
      process.exitCode = state.gate_can_pass || state.handoff_passed_gate === true ? 0 : 1;
      break;
    }
    case 'design-handoff': {
      const result = harness.designHandoff(slug, { force: Boolean(values.force) });
      if (!json && result.output) process.stdout.write(`${result.output}\n`);
      out(result.ok ? 'Handoff exported.' : 'Handoff refused. Approve every screen in the studio first.', result);
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case 'design-lint': {
      if (!values.url) fail('design-lint needs --url <preview url> for the running build.');
      if (!values.domain) fail('design-lint needs --domain <domain> so the result is bound to the surface it checked.');
      const result = harness.designLintBuild(slug, values.domain as string, values.url as string);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        for (const problem of result.problems) process.stdout.write(`  ${problem}\n`);
        process.stdout.write(result.passed ? '\nThe build matches the frozen contract.\n' : `\n${result.problems.length} contract problem(s).\n`);
      }
      process.exitCode = result.passed ? 0 : 1;
      break;
    }
    case 'status': {
      const status = harness.status(slug);
      if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else {
        process.stdout.write(`${status.slug}: ${status.state}\n`);
        process.stdout.write(`  approval: ${status.approval ? `${status.approval.approved_by} at ${status.approval.created_at}` : 'none'}\n`);
        process.stdout.write(`  sources:  ${status.sources.length ? status.sources.map((s) => `${s.status}`).join(', ') : 'none'}\n`);
        for (const run of status.runs) process.stdout.write(`  run: ${run.domain} via ${run.adapter} attempt ${run.attempt} gate ${run.gate_exit}\n`);
      }
      break;
    }
    default:
      fail(`Unknown command "${command}".\n\n${USAGE}`);
  }
} catch (error) {
  fail(`${(error as Error).message}`);
} finally {
  harness.close();
}
