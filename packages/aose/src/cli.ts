#!/usr/bin/env node
/**
 * aose — the AOSE v2 command line.
 *
 * Every phase of the lifecycle is a subcommand, and every subcommand either
 * advances the recorded state or refuses with a reason. Nothing here decides
 * anything a human should decide: approval is a command a person runs.
 */
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { Harness } from './harness.ts';
import { lintDir } from './lint.ts';
import { formatConverge } from './converge.ts';
import { ADAPTERS } from './adapters/index.ts';

const USAGE = `aose — Agent-Oriented Software Engineering harness v2

  Lifecycle
    init <slug>                    Create a project and its blueprint directory
    capture <slug>                 Load constitution.yaml + idea.yaml into the ledger
    ready <slug>                   Declare the idea free of open questions
    research-add <slug> --file F   Record a research source
    research-verify <slug>         Fetch every source and check it says what was claimed
    compile <slug>                 Normalize the triad, derive upstream exports and build order
    lint <slug|--dir D>            Run LINT-01..26 over a blueprint
    review <slug>                  Machine review: lint clean, citations verified
    approve <slug> --by NAME       Record a human approval
    dispatch <slug> [options]      Cold-dispatch domains to a worker, then run their gates
    converge <slug>                Score the four pillars against produced evidence
    export <slug>                  Write blueprint.yaml + implementation-plan.md
    archive <slug>                 Copy the finished blueprint into blueprints/_archive
    validate <slug>                Replay the transition log and audit approvals
    status <slug>                  Show current state, sources, runs

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
    by: { type: 'string' }, domain: { type: 'string' }, adapter: { type: 'string' },
    fixture: { type: 'string' }, attempts: { type: 'string' }, timeout: { type: 'string' },
    adapters: { type: 'string' },
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
