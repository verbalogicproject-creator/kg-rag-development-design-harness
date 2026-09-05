/**
 * The design plane's contract, and the four rules that make it bite.
 *
 * LINT-27/28 only ever proved that files exist. That is how design.json could
 * carry seven contrast targets from the day a project was initialised without a
 * single one of them ever being measured. These tests cover the rules that
 * replace existence with verification, and each one is written adversarially:
 * the interesting case is the contract that looks fine and is not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { lintDir } from '../src/lint.ts';
import { DesignSystemSchema, DesignBindingSchema } from '../src/schema.ts';

const TOKENS_HASH = 'c0951e1a1aa3f4a673ed8cc85a06b79ff7173556982d91545822ccf8e74bf58f';

const designSystem = (over: Record<string, unknown> = {}) => ({
  design_system: {
    name: 'T', version: 1,
    contract: 'design/DESIGN.md',
    tokens: 'design/tokens.css',
    tokens_hash: `sha256:${TOKENS_HASH}`,
    direction: {
      family: 'precise-technical',
      thesis: 'A quiet instrument for someone working alone.',
      anti_direction: [
        { id: 'AD-01', rule: 'the convergence composite', threshold: 3,
          components: ['warm off-white ground', 'default display serif', 'clay accent'],
          source: 'natural-color-and-humanization.md' },
      ],
    },
    scales: {
      type: { steps: { body: '1rem' } },
      spacing: { base: '4px', steps: ['0.5rem', '1rem'] },
      radius: { steps: ['0.25rem'] },
      motion: { durations: { instant: '0ms', base: '200ms' } },
    },
    palette: { max_hues: 3, neutral_ramp: ['background', 'content'], modes: ['light', 'dark'] },
    accessibility: { contrast_pairs: [{ foreground: 'content', background: 'background', target: 4.5 }] },
    required_states: ['empty', 'loading', 'error', 'populated'],
    requirements: [{
      id: 'DREQ-01',
      ears: 'WHEN any surface renders THE SYSTEM SHALL resolve every colour to a declared token.',
      enforcement: 'gate', verified_by: ['DSC-01'],
    }],
    verification: {
      check_suite: 'design/__checks__/design.test.ts',
      report: 'design/__checks__/tokens.report.json',
      scenarios: [{ id: 'DSC-01', given: 'g', when: 'w', then: 't', test_name: 'every visual value comes from a design token' }],
    },
    ...over,
  },
});

/** A minimal blueprint with one surface domain, written to disk for lintDir. */
function blueprint(options: {
  system?: Record<string, unknown> | null;
  surfaces?: unknown[];
  tokensHash?: string;
  bindSystem?: boolean;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aose-dsys-'));
  mkdirSync(join(dir, 'design'), { recursive: true });

  writeFileSync(join(dir, 'constitution.yaml'), YAML.stringify({
    constitution: {
      name: 'T', version: 1, stack: ['node24'],
      articles: [{ id: 'ART-01', title: 'T', rule: 'R', enforcement: 'lint' }],
      budgets: { max_attempts: 2, max_respec: 2, timeout_minutes: 15, max_payload_tokens: 4000 },
    },
  }));
  writeFileSync(join(dir, 'idea.yaml'), YAML.stringify({
    idea: {
      title: 'T', goal: 'G', audience: 'A', seed_author: 'human', scope_class: 'bounded',
      success_criteria: ['WHEN it runs THE SYSTEM SHALL work.'],
      non_goals: [], constraints: [], open_questions: [],
    },
  }));
  writeFileSync(join(dir, 'system.manifest.yaml'), YAML.stringify({
    system: {
      name: 'T', constitution: 'constitution.yaml', scope_class: 'bounded',
      boundaries: [{
        domain: 'ui/client', responsibility: 'R', depends_on: [], exports: ['App'],
        spec: 'ui.client.spec.yaml', task: 'ui.client.task.yaml',
      }],
    },
    invariants: ['ART-01'], decisions: [],
  }));

  const design: Record<string, unknown> = {
    contract: 'design/DESIGN.md',
    target_stack: 'vite-react-tailwind',
    surfaces: options.surfaces ?? [{
      id: 'board', density: 'dense', states: ['empty', 'loading', 'error', 'populated'], primary_action: 'go',
    }],
  };
  if (options.bindSystem !== false) design.system = 'design.system.yaml';

  writeFileSync(join(dir, 'ui.client.spec.yaml'), YAML.stringify({
    module: 'ui/client', runtime: 'vite',
    requirements: [{ id: 'REQ-01', ears: 'WHEN it renders THE SYSTEM SHALL show a board.', verified_by: ['SC-01'] }],
    types: "type E = 'BAD';\ntype R =\n  | { ok: true; value: number }\n  | { ok: false; error: E };",
    design,
    contracts: { 'App(): R': { kind: 'query', precondition: 'p', postcondition: 'q', errors: [] } },
    verification: { test_suite: 't.test.ts', scenarios: [{ id: 'SC-01', given: 'g', when: 'w', then: 't', test_name: 'renders' }] },
  }));
  writeFileSync(join(dir, 'ui.client.task.yaml'), YAML.stringify({
    task: {
      target_module: 'ui/client',
      context: { constitution_articles: ['ART-01'], spec: 'ui.client.spec.yaml', upstream_exports: {} },
      deliverables: ['app.tsx'],
      execution_gate: { command: 'npm test', success_criteria: 'exit 0' },
      budget: {},
    },
  }));

  writeFileSync(join(dir, 'design', 'DESIGN.md'), '# T\n');
  writeFileSync(join(dir, 'design', 'design.json'), JSON.stringify({
    schemaVersion: 1, tokensHash: options.tokensHash ?? TOKENS_HASH,
  }));
  if (options.system !== null) {
    writeFileSync(join(dir, 'design.system.yaml'), YAML.stringify(options.system ?? designSystem()));
  }
  return dir;
}

const idsOf = (r: { errors: { id: string }[]; warnings: { id: string }[] }) =>
  ({ errors: r.errors.map((f) => f.id), warnings: r.warnings.map((f) => f.id) });

/* ---- the schema ---- */

test('a direction must be chosen from the five canonical families, not invented', () => {
  // "Terminal" is the failure this whole artifact exists to prevent: a plausible
  // family invented on the spot, when the corpus already enumerates five and
  // explicitly cautions against decorative terminal clichés.
  const bad = DesignSystemSchema.safeParse(designSystem({
    direction: { family: 'terminal', thesis: 'T', anti_direction: [{ id: 'AD-01', rule: 'r', source: 's' }] },
  }));
  assert.equal(bad.success, false, 'an invented family must be rejected');

  const good = DesignSystemSchema.safeParse(designSystem());
  assert.equal(good.success, true);
  assert.equal(good.data!.design_system.direction.family, 'precise-technical');
});

test('a contract with no anti_direction is rejected by the schema', () => {
  const r = DesignSystemSchema.safeParse(designSystem({
    direction: { family: 'precise-technical', thesis: 'T', anti_direction: [] },
  }));
  assert.equal(r.success, false, 'a review with nothing to cite has reviewed nothing (ART-11)');
});

test('tokens_hash must be a real sha256, so a placeholder cannot freeze anything', () => {
  for (const value of ['sha256:pending', 'pending', 'sha256:abc', '']) {
    const r = DesignSystemSchema.safeParse(designSystem({ tokens_hash: value }));
    assert.equal(r.success, false, `"${value}" must not pass as a frozen hash`);
  }
});

test('a bare surface string still validates, so older blueprints keep working', () => {
  const bare = DesignBindingSchema.safeParse({ contract: 'design/DESIGN.md', surfaces: ['board', 'inbox'] });
  assert.equal(bare.success, true);
  const full = DesignBindingSchema.safeParse({
    contract: 'design/DESIGN.md',
    surfaces: [{ id: 'board', density: 'dense', states: ['empty'], primary_action: 'go' }],
  });
  assert.equal(full.success, true);
});

/* ---- LINT-32: the contract is present ---- */

test('LINT-32 fails when the declared design.system does not exist', () => {
  const dir = blueprint({ system: null });
  assert.ok(idsOf(lintDir(dir)).errors.includes('LINT-32'));
});

test('LINT-32 refuses a design.system that escapes the project', () => {
  const dir = blueprint();
  const spec = YAML.parse(readFileSync(join(dir, 'ui.client.spec.yaml'), 'utf8'));
  spec.design.system = '../../../etc/design.system.yaml';
  writeFileSync(join(dir, 'ui.client.spec.yaml'), YAML.stringify(spec));
  const result = lintDir(dir);
  assert.ok(idsOf(result).errors.includes('LINT-32'));
  assert.match(result.errors.find((f) => f.id === 'LINT-32')!.message, /outside the project/);
});

test('LINT-32 warns when a surface binds a contract but declares no system', () => {
  const dir = blueprint({ bindSystem: false, system: null });
  assert.ok(idsOf(lintDir(dir)).warnings.includes('LINT-32'), 'file-existence checking is not verification');
});

/* ---- LINT-33: the contract still describes the tokens it approved ---- */

test('LINT-33 catches tokens edited after the contract froze them', () => {
  // The design-plane twin of an approval superseded by a later artifact edit:
  // the contract still says "approved", but it no longer describes what shipped.
  const dir = blueprint({ tokensHash: 'f'.repeat(64) });
  const result = lintDir(dir);
  assert.ok(idsOf(result).errors.includes('LINT-33'));
  assert.match(result.errors.find((f) => f.id === 'LINT-33')!.message, /tokens drift/);
});

test('LINT-33 passes when the frozen hash still matches', () => {
  assert.equal(idsOf(lintDir(blueprint())).errors.includes('LINT-33'), false);
});

/* ---- LINT-34: a surface says what it is ---- */

test('LINT-34 warns on a surface that omits a required state', () => {
  const dir = blueprint({
    surfaces: [{ id: 'board', density: 'dense', states: ['populated'], primary_action: 'go' }],
  });
  const result = lintDir(dir);
  assert.ok(idsOf(result).warnings.includes('LINT-34'));
  const message = result.warnings.find((f) => f.id === 'LINT-34')!.message;
  for (const state of ['empty', 'loading', 'error']) assert.match(message, new RegExp(state));
});

test('LINT-34 warns on a bare surface name, which no state check can reach', () => {
  const dir = blueprint({ surfaces: ['board'] });
  assert.ok(idsOf(lintDir(dir)).warnings.includes('LINT-34'));
});

/* ---- LINT-35: the negative constraints are real ---- */

test('LINT-35 rejects an anti_direction rule that can never fire', () => {
  // A threshold above the component count is worse than no rule: it reads as a
  // guard in the contract and is unreachable in the check.
  const dir = blueprint({
    system: designSystem({
      direction: {
        family: 'precise-technical', thesis: 'T',
        anti_direction: [{ id: 'AD-01', rule: 'the composite', threshold: 4, components: ['a', 'b'], source: 's' }],
      },
    }),
  });
  const result = lintDir(dir);
  assert.ok(idsOf(result).errors.includes('LINT-35'));
  assert.match(result.errors.find((f) => f.id === 'LINT-35')!.message, /can never fire/);
});

test('LINT-35 warns on an anti_direction entry with no source to check', () => {
  const dir = blueprint({
    system: designSystem({
      direction: {
        family: 'precise-technical', thesis: 'T',
        anti_direction: [{ id: 'AD-01', rule: 'no gradients' }],
      },
    }),
  });
  assert.ok(idsOf(lintDir(dir)).warnings.includes('LINT-35'));
});

/* ---- the shipped contract ---- */

test('the dashboard design system is valid and its composite rule can fire', () => {
  const raw = YAML.parse(
    readFileSync('blueprints/freelance-dashboard/design.system.yaml', 'utf8'),
  );
  const parsed = DesignSystemSchema.safeParse(raw);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));

  const system = parsed.data!.design_system;
  assert.equal(system.direction.family, 'precise-technical');

  const composite = system.direction.anti_direction.find((a) => a.id === 'AD-01')!;
  assert.ok(composite.threshold! <= composite.components.length, 'the composite rule must be reachable');

  // Every declared contrast pair from design.json survived into the contract,
  // which is the point: they have been declared since day one and never measured.
  assert.equal(system.accessibility.contrast_pairs.length, 7);
  assert.ok(system.accessibility.modes_must_both_pass);

  // Each gated requirement names a scenario, and each scenario names a test.
  const scenarios = new Set(system.verification.scenarios.map((s) => s.id));
  for (const requirement of system.requirements) {
    for (const id of requirement.verified_by) assert.ok(scenarios.has(id), `${requirement.id} cites unknown ${id}`);
  }
  for (const scenario of system.verification.scenarios) assert.ok(scenario.test_name.length > 0);
});

/* ---- LINT-33: the generated files, not only the recorded values ---- */

test('LINT-33 catches a hand-edit to a generated file', () => {
  // design.json records a hash for every generated file, and nothing read them.
  // So editing tokens.css changed the file, left tokensHash untouched, and
  // passed lint and the whole design gate. The contract says these files are
  // generated and must be regenerated rather than edited; this is the mechanism
  // for that sentence.
  const dir = blueprint();
  const tokens = join(dir, 'design', 'tokens.css');
  writeFileSync(tokens, ':root { --ls-color-content: #111111; }');
  const state = JSON.parse(readFileSync(join(dir, 'design', 'design.json'), 'utf8'));
  state.provenance = { 'tokens.css': 'f'.repeat(64) };
  writeFileSync(join(dir, 'design', 'design.json'), JSON.stringify(state));

  const result = lintDir(dir);
  const finding = result.errors.find((f) => f.id === 'LINT-33' && /edited by hand/.test(f.message));
  assert.ok(finding, 'a generated file that no longer matches its recorded hash must fail');
  assert.match(finding!.message, /the next regeneration discards the edit/);
});

test('LINT-33 passes when a generated file still matches what was recorded', () => {
  const dir = blueprint();
  const tokens = join(dir, 'design', 'tokens.css');
  const body = ':root { --ls-color-content: #111111; }';
  writeFileSync(tokens, body);
  const state = JSON.parse(readFileSync(join(dir, 'design', 'design.json'), 'utf8'));
  state.provenance = { 'tokens.css': createHash('sha256').update(body).digest('hex') };
  writeFileSync(join(dir, 'design', 'design.json'), JSON.stringify(state));

  assert.equal(lintDir(dir).errors.some((f) => /edited by hand/.test(f.message)), false);
});

test('a malformed design.json skips this rule without abandoning other domains', () => {
  // The catch here once swallowed a ReferenceError, which made a check that
  // never ran look exactly like a check that passed. It now narrows to parse
  // failure, and must not break out of the domain loop either.
  const dir = blueprint();
  writeFileSync(join(dir, 'design', 'design.json'), '{ not json');
  const result = lintDir(dir);
  assert.equal(result.errors.some((f) => f.id === 'LINT-33'), false, 'unreadable state is LINT-27\'s business');
  assert.ok(Array.isArray(result.warnings), 'and the rest of the lint still ran');
});
