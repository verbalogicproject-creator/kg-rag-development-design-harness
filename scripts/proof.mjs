/**
 * The deterministic end-to-end proof.
 *
 * `npm run proof` was declared in package.json and pointed at a file that had
 * never existed, so the repository's own headline claim — that the whole
 * lifecycle runs start to finish — was a declaration with no mechanism behind
 * it. That is the exact failure this harness exists to make impossible, and it
 * had one at its front door.
 *
 * Everything here is offline and reproducible. The worker is the fixture
 * copier, so nothing depends on a model; the gate is run for real by the
 * harness, so the pass is evidence rather than a claim. Citation verification
 * uses a recorded arXiv response and says so — the live fetch path has its own
 * tests, and a proof that needs the network is not a proof you can run.
 *
 * Exits 0 only if every stage succeeded and the exported artifacts exist.
 */
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { Harness } from '../packages/aose/src/harness.ts';
import { Ledger } from '../packages/aose/src/ledger.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SLUG = 'tictactoe';
const FIXTURES = join(ROOT, 'examples', 'tictactoe-vanilla-es6');

/** The recorded arXiv response for the one source tictactoe cites. */
const recordedFetch = async (url) => ({
  ok: true,
  status: 200,
  text: async () => url.includes('arxiv')
    ? '<feed><entry><title>Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?</title>'
      + '<summary>Generating preconditions alongside postconditions reduces the false alarms a verifier reports when contracts are checked.</summary></entry></feed>'
    : '{"full_name":"x/y","description":"preconditions postconditions verifier false alarms"}',
});

let failed = 0;
function step(label, run) {
  try {
    const detail = run();
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.log(`  FAIL  ${label}\n        ${error.message}`);
    failed += 1;
    return false;
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'aose-proof-'));
  mkdirSync(join(root, 'blueprints'), { recursive: true });
  cpSync(join(ROOT, 'blueprints', SLUG), join(root, 'blueprints', SLUG), { recursive: true });
  const harness = new Harness(root, new Ledger(join(root, 'proof.sqlite')));

  console.log(`aose proof — ${SLUG}, fake worker, real gate`);
  console.log(`workspace: ${root}\n`);

  step('init',        () => harness.init(SLUG).state);
  step('capture',     () => harness.capture(SLUG).state);
  step('ready',       () => { harness.ready(SLUG); return harness.ledger.getProject(SLUG).state; });
  step('research-add', () => {
    harness.addSource(SLUG, YAML.parse(readFileSync(join(ROOT, 'blueprints', SLUG, 'sources', 'nl2contract.yaml'), 'utf8')));
    return '1 source';
  });
  step('compile',     () => harness.compile(SLUG).state);

  const verified = await harness.verifySources(SLUG, recordedFetch);
  step('research-verify', () => {
    const bad = verified.filter((source) => source.status !== 'verified');
    if (bad.length) throw new Error(`${bad.length} source(s) did not verify`);
    return `${verified.length} verified against a recorded response (offline)`;
  });

  step('lint', () => {
    const report = harness.lint(SLUG);
    if (report.errors.length) throw new Error(`${report.errors.length} lint error(s)`);
    return `0 errors, ${report.warnings.length} warning(s)`;
  });
  step('review',  () => harness.review(SLUG).state);
  step('approve', () => harness.approve(SLUG, 'proof run').state);

  const results = [];
  for (const domain of ['core/engine', 'ui/client']) {
    // eslint-disable-next-line no-await-in-loop -- domains are ordered by dependency
    const [result] = await harness.dispatch(SLUG, { domain, adapter: 'fake', fixtureRoot: FIXTURES });
    results.push(result);
    step(`dispatch ${domain}`, () => {
      if (!result.passed) throw new Error(`gate exit ${result.attempts.at(-1)?.gate?.exit_code}`);
      const gate = result.attempts.at(-1).gate;
      return `gate exit 0, stdout sha ${gate.stdout_sha256.slice(0, 12)}`;
    });
  }

  step('converge', () => {
    const { reports, passed } = harness.converge(SLUG);
    const low = reports.flatMap((r) => r.pillars).filter((p) => p.score < 70);
    if (!passed) throw new Error(`pillars below 70: ${low.map((p) => `${p.name} ${p.score}`).join(', ')}`);
    return reports.map((r) => `${r.domain} ${r.pillars.map((p) => `${p.name} ${Math.round(p.score)}`).join('/')}`).join('; ');
  });

  step('export', () => {
    harness.export(SLUG);
    const dir = harness.dir(SLUG);
    for (const file of ['blueprint.yaml', 'implementation-plan.md']) {
      if (!existsSync(join(dir, file))) throw new Error(`${file} was not written`);
    }
    return 'blueprint.yaml + implementation-plan.md';
  });

  step('validate', () => {
    const report = harness.validate(SLUG);
    if (!report.valid) throw new Error(report.problems.join('; '));
    return `transition log replays clean, state ${harness.ledger.getProject(SLUG).state}`;
  });

  console.log(failed ? `\nPROOF FAILED — ${failed} stage(s)` : '\nPROOF PASSED — every stage produced its evidence');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(`proof crashed: ${error.stack}`); process.exit(1); });
