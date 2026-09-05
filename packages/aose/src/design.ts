/**
 * The design plane.
 *
 * L.S.Design and this harness turned out to be the same machine pointed at
 * different planes: a contract of non-negotiables, a lint pass, a human gate
 * that freezes what it approved, a cold build against the frozen artifact, and
 * a scored review. So the design phase is not bolted on here — it is wired to
 * the same ledger, the same approval, and the same converge report.
 *
 * This module drives the studio CLI rather than reimplementing it. Until the
 * package is published, it falls back to running the repository directly.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { containedPath, isContained } from './integrity.ts';

export const STUDIO_PACKAGE = 'ls-design-studio';
export const STUDIO_REPO = 'github:verbalogicproject-creator/L.S.Design-studio';

export interface StudioInvocation { cmd: string; args: string[]; source: 'path' | 'npm' | 'repo'; }

/** Resolve how to run the studio: an installed binary, the published package, or the repo. */
export function resolveStudio(): StudioInvocation {
  const onPath = spawnSync('sh', ['-c', `command -v ${STUDIO_PACKAGE}`], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    return { cmd: onPath.stdout.trim(), args: [], source: 'path' };
  }
  const published = spawnSync('npm', ['view', STUDIO_PACKAGE, 'version'], { encoding: 'utf8', timeout: 30_000 });
  if (published.status === 0 && published.stdout.trim()) {
    return { cmd: 'npx', args: ['-y', STUDIO_PACKAGE], source: 'npm' };
  }
  return { cmd: 'npx', args: ['-y', STUDIO_REPO], source: 'repo' };
}

export interface StudioResult { ok: boolean; stdout: string; stderr: string; status: number | null; command: string; }

export function runStudio(args: string[], options: { cwd?: string; timeoutMinutes?: number; input?: string } = {}): StudioResult {
  const studio = resolveStudio();
  const full = [...studio.args, ...args];
  const result = spawnSync(studio.cmd, full, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: (options.timeoutMinutes ?? 10) * 60_000,
    input: options.input,
    env: { ...process.env },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    command: `${studio.cmd} ${full.join(' ')}`,
  };
}

/* ------------------------------------------------------------------ */
/* Reading the design plane's state without the studio running.        */
/* ------------------------------------------------------------------ */

export interface DesignState {
  root: string;
  contract_exists: boolean;
  tokens_exists: boolean;
  preview_exists: boolean;
  screens: { id: string; decision: string; stale: boolean }[];
  approved_screens: number;
  total_screens: number;
  handoff_exists: boolean;
  handoff_passed_gate: boolean | null;
  handoff_digest: string;
  gate_can_pass: boolean;
  blockers: string[];
}

/** Read design/ as the studio left it. The studio owns design.json; we only read. */
export function readDesignState(designRoot: string): DesignState {
  const state: DesignState = {
    root: designRoot,
    contract_exists: existsSync(join(designRoot, 'DESIGN.md')),
    tokens_exists: existsSync(join(designRoot, 'tokens.css')),
    preview_exists: existsSync(join(designRoot, 'preview.html')),
    screens: [], approved_screens: 0, total_screens: 0,
    handoff_exists: existsSync(join(designRoot, 'handoff')),
    handoff_passed_gate: null,
    handoff_digest: '',
    gate_can_pass: false,
    blockers: [],
  };

  const jsonPath = join(designRoot, 'design.json');
  if (existsSync(jsonPath)) {
    try {
      const doc = JSON.parse(readFileSync(jsonPath, 'utf8')) as { screens?: Record<string, unknown>[] | Record<string, unknown> };
      const raw = Array.isArray(doc.screens) ? doc.screens : Object.values(doc.screens ?? {});
      state.screens = (raw as Record<string, unknown>[]).map((screen) => ({
        id: String(screen.id ?? screen.name ?? 'screen'),
        decision: String((screen.decision as { state?: string } | undefined)?.state ?? screen.decision ?? 'pending'),
        stale: Boolean(screen.stale),
      }));
      state.total_screens = state.screens.length;
      state.approved_screens = state.screens.filter((s) => s.decision === 'approved').length;
    } catch (error) {
      state.blockers.push(`design.json could not be read: ${(error as Error).message}`);
    }
  }

  /* Gate status comes from the studio's machine-written record where one
     exists. Reading it out of BRIEF.md prose was forgeable by hand-authoring
     the file, so prose is now only a fallback and is reported as unverified
     rather than as a pass. */
  const receipt = join(designRoot, 'handoff', 'gate.json');
  if (state.handoff_exists && existsSync(receipt)) {
    try {
      const doc = JSON.parse(readFileSync(receipt, 'utf8')) as { passed?: boolean; forced?: boolean; digest?: string };
      state.handoff_passed_gate = doc.passed === true && doc.forced !== true;
      state.handoff_digest = typeof doc.digest === 'string' ? doc.digest : '';
    } catch {
      state.handoff_passed_gate = null;
      state.blockers.push('handoff/gate.json is unreadable, so the gate result cannot be trusted.');
    }
  } else if (state.handoff_exists && existsSync(join(designRoot, 'handoff', 'design.json'))) {
    /* The studio writes its gate result into the handoff's own design.json —
       `gates.screens = { passed, at, handoffSha256 }` — and the harness was
       looking only for a gate.json this studio version never emits, so a
       properly gated handoff read as "gate state unknown".
       
       The flag alone would be a claim. It counts only when the shipped
       `handoff.sha256` manifest verifies, which proves the files on disk are
       the ones the gate was recorded against. That manifest was the other
       thing being written and never read. */
    try {
      const doc = JSON.parse(readFileSync(join(designRoot, 'handoff', 'design.json'), 'utf8')) as
        { gates?: { screens?: { passed?: boolean; handoffSha256?: string } }; status?: string };
      const receipt = doc.gates?.screens;
      const integrity = verifyHandoff(join(designRoot, 'handoff'));
      if (receipt?.passed === true && integrity.intact) {
        state.handoff_passed_gate = true;
        state.handoff_digest = receipt.handoffSha256 ?? '';
      } else if (receipt?.passed === true) {
        state.handoff_passed_gate = null;
        state.blockers.push(
          `The studio recorded a passed screens gate, but the handoff no longer matches its own manifest`
          + `${integrity.mismatches.length ? `: ${integrity.mismatches.slice(0, 3).join(', ')} changed` : ''}`
          + `${integrity.missing.length ? `: ${integrity.missing.slice(0, 3).join(', ')} missing` : ''}`
          + '. Re-export the handoff.');
      } else {
        state.handoff_passed_gate = false;
      }
    } catch {
      state.handoff_passed_gate = null;
      state.blockers.push('handoff/design.json is unreadable, so the gate result cannot be trusted.');
    }
  } else if (state.handoff_exists) {
    const brief = join(designRoot, 'handoff', 'BRIEF.md');
    const body = existsSync(brief) ? readFileSync(brief, 'utf8') : '';
    if (/not\s+hav(e|ing)\s+passed\s+the\s+gate|provisional/i.test(body)) {
      state.handoff_passed_gate = false;
    } else {
      state.handoff_passed_gate = null;
      state.blockers.push('The handoff carries no gate.json receipt, so it cannot be shown to have passed the studio gate. Re-export it, or accept it explicitly as provisional.');
    }
  }

  if (!state.contract_exists) state.blockers.push('No design/DESIGN.md. Run the ls-design-contract skill, or `aose design init`.');
  if (state.total_screens === 0) state.blockers.push('No screens have been added to the studio yet.');
  const pending = state.screens.filter((s) => s.decision !== 'approved');
  if (pending.length) state.blockers.push(`${pending.length} screen(s) are not approved: ${pending.map((s) => s.id).slice(0, 5).join(', ')}.`);
  const stale = state.screens.filter((s) => s.stale);
  if (stale.length) state.blockers.push(`${stale.length} screen(s) are stale against the current tokens.`);

  state.gate_can_pass = state.contract_exists && state.total_screens > 0 && pending.length === 0 && stale.length === 0;
  return state;
}


/* ------------------------------------------------------------------ */
/* Handoff integrity — checking the hashes the studio already writes.  */
/* ------------------------------------------------------------------ */

export interface HandoffIntegrity {
  manifest_present: boolean;
  checked: number;
  mismatches: string[];
  missing: string[];
  intact: boolean;
}

/**
 * Verify a handoff against the `handoff.sha256` manifest the studio ships.
 *
 * The manifest was being written and nothing read it — the same gap this
 * harness reported to the studio and then had itself. A hash nobody checks
 * documents an intention; a hash that is checked is evidence, and it is what
 * lets a machine-written "the gate passed" receipt mean anything, because the
 * receipt describes a set of files and this proves those are the files.
 */
export function verifyHandoff(handoffDir: string): HandoffIntegrity {
  const manifestPath = join(handoffDir, 'handoff.sha256');
  const result: HandoffIntegrity = {
    manifest_present: existsSync(manifestPath),
    checked: 0, mismatches: [], missing: [], intact: false,
  };
  if (!result.manifest_present) return result;

  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    // `sha256sum` format: "<hex>  <path>", two spaces, path may contain spaces.
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, expected, relative] = match;
    const file = containedPath(handoffDir, relative);
    if (!existsSync(file)) { result.missing.push(relative); continue; }
    result.checked += 1;
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) result.mismatches.push(relative);
  }
  result.intact = result.checked > 0 && result.mismatches.length === 0 && result.missing.length === 0;
  return result;
}

/**
 * Files a surface worker legitimately receives from the design plane.
 * The frozen handoff is treated exactly like an upstream domain's deliverables.
 */
export function handoffSeed(blueprintDir: string, handoffPath = 'design/handoff'): { path: string; from: string }[] {
  // A blueprint-declared path is untrusted input. Without this check a binding
  // like `../../other-project/handoff` would seed another project's approved
  // briefs into a worker that should only ever see its own.
  const root = containedPath(blueprintDir, handoffPath);
  if (!existsSync(root)) return [];
  const seed: { path: string; from: string }[] = [];
  for (const file of ['BRIEF.md', 'DESIGN.md', 'tokens.css', 'tailwind.theme.css', 'screens.json', 'target_stack.json']) {
    const from = join(root, file);
    if (existsSync(from)) seed.push({ path: join('design', file), from });
  }

  /* The approved screens themselves.
   *
   * These were missing, and their absence quietly broke the property the design
   * plane exists for: "a token-driven approved screen and the shipped interface
   * are two renders of one file, so there is no drift to compare by eye". That
   * only holds if the worker HAS the approved screen. Without it the worker
   * builds from prose and tokens, and the comparison becomes exactly the
   * eyeballing the handoff was meant to remove.
   *
   * The markup only. A PNG is bulk a text worker cannot read, and the HTML is
   * the artifact a person actually approved. */
  const screensDir = join(root, 'screens');
  if (existsSync(screensDir)) {
    for (const entry of readdirSync(screensDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = join(screensDir, entry.name, 'code.html');
      if (existsSync(from)) seed.push({ path: join('design', 'screens', entry.name, 'code.html'), from });
    }
  }

  /* Quarantined fixture values, so the worker can tell invented content from
   * real content. ART-08 forbids shipping these; a worker that has never seen
   * them cannot honour a rule about them. */
  const fixturesDir = join(root, 'fixtures');
  if (existsSync(fixturesDir)) {
    for (const name of readdirSync(fixturesDir)) {
      if (!name.endsWith('.json')) continue;
      seed.push({ path: join('design', 'fixtures', name), from: join(fixturesDir, name) });
    }
  }

  return seed;
}

/** Parse a `lint-build` run into a pass/fail plus its reported problems. */
export function parseLintBuild(result: StudioResult): { passed: boolean; problems: string[] } {
  const problems = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .filter((line) => /\b(error|fail|drift|violation)\b/i.test(line))
    .map((line) => line.trim())
    .filter(Boolean);
  return { passed: result.ok, problems: problems.slice(0, 20) };
}
