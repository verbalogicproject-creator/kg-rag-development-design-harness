/**
 * Cold dispatch.
 *
 * One domain, one fresh worktree, one fresh process per attempt — the Ralph
 * Wiggum loop's statelessness, with Anthropic's progress log as the only thing
 * carried forward, and a hard attempt bound the loop-until-green literature
 * never specifies. The gate is run by the harness after the worker exits.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAdapter } from './adapters/index.ts';
import type { AdapterOptions } from './adapters/index.ts';
import { readCodexLastMessage } from './adapters/codex.ts';
import { buildPayload, estimateTokens } from './payload.ts';
import { recall } from './recall.ts';
import { runGate, cleanEnv, failureNote } from './gate.ts';
import type { GateResult } from './gate.ts';
import type { Constitution, Spec, Task } from './schema.ts';
import type { Ledger } from './ledger.ts';

export interface DispatchOptions {
  slug: string;
  domain: string;
  adapter: string;
  workspaceRoot: string;
  repoRoot: string;
  spec: Spec;
  task: Task['task'];
  constitution?: Constitution;
  maxAttempts?: number;
  timeoutMinutes?: number;
  fixtureRoot?: string;
  seed?: SeedFile[];
  dryRun?: boolean;
  keepWorktree?: boolean;
  adapterOptions?: AdapterOptions;
  onEvent?: (message: string) => void;
}

export interface AttemptRecord {
  attempt: number;
  worker_exit: number | null;
  worker_timed_out: boolean;
  worker_ms: number;
  gate: GateResult | null;
  run_dir: string;
  worktree: string;
  final_text: string;
  payload_tokens: number;
}

export interface DispatchResult {
  domain: string;
  adapter: string;
  passed: boolean;
  attempts: AttemptRecord[];
  command_preview: string;
  exhausted: boolean;
  worktree: string;
}

export interface SeedFile { path: string; from?: string; content?: string; }

/**
 * Build a cold workspace for one attempt.
 *
 * Deliberately NOT a `git worktree` of the project: that would check the whole
 * repository out and hand the worker every other domain's source, which is
 * exactly the context leakage cold dispatch exists to prevent. Instead the
 * directory starts empty, receives only its seed (upstream deliverables and a
 * package manifest), and is then committed to a throwaway git repo so that
 * `git status` afterwards names precisely what the worker changed.
 */
export function createWorkspace(path: string, seed: SeedFile[] = []): { seeded: string[] } {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });

  const seeded: string[] = [];
  for (const file of seed) {
    const target = join(path, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (file.content !== undefined) { writeFileSync(target, file.content); seeded.push(file.path); }
    else if (file.from && existsSync(file.from)) { cpSync(file.from, target); seeded.push(file.path); }
  }

  try {
    execFileSync('git', ['init', '-q'], { cwd: path, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'harness@aose.local'], { cwd: path, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'aose harness'], { cwd: path, stdio: 'pipe' });
    execFileSync('git', ['add', '-A'], { cwd: path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'aose: cold workspace baseline', '--allow-empty'], { cwd: path, stdio: 'pipe' });
  } catch { /* scoring degrades to "no baseline"; dispatch still runs */ }

  return { seeded };
}

export function removeWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function quote(value: string): string {
  return /[\s"'$`\\|&;<>()]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

export function previewCommand(adapterName: string, payload: string, worktree: string, runDir: string, options: AdapterOptions): string {
  const invocation = getAdapter(adapterName).build(payload, worktree, runDir, options);
  const shown = invocation.args.map((arg) => (arg === payload ? '<payload>' : quote(arg)));
  const suffix = invocation.stdin ? ' < payload.md' : '';
  return `${invocation.cmd} ${shown.join(' ')}${suffix}`;
}

async function runWorker(adapterName: string, payload: string, worktree: string, runDir: string, options: AdapterOptions):
  Promise<{ exit: number | null; timedOut: boolean; ms: number; stdout: string; stderr: string }> {
  const invocation = getAdapter(adapterName).build(payload, worktree, runDir, options);
  const timeoutMs = (options.timeoutMinutes ?? 15) * 60_000;
  const started = Date.now();

  return new Promise((resolvePromise) => {
    const child = spawn(invocation.cmd, invocation.args, {
      cwd: invocation.cwd,
      env: cleanEnv(invocation.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ exit: 127, timedOut, ms: Date.now() - started, stdout, stderr: `${stderr}\n${(error as Error).message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exit: timedOut ? null : code, timedOut, ms: Date.now() - started, stdout, stderr });
    });
    if (invocation.stdin !== undefined) { child.stdin.write(invocation.stdin); }
    child.stdin.end();
  });
}

export async function dispatch(ledger: Ledger, options: DispatchOptions): Promise<DispatchResult> {
  const {
    slug, domain, adapter, workspaceRoot, repoRoot, spec, task, constitution,
    fixtureRoot, seed = [], dryRun = false, keepWorktree = false, onEvent = () => {},
  } = options;

  const maxAttempts = options.maxAttempts ?? task.budget.max_attempts
    ?? constitution?.constitution.budgets.max_attempts ?? 2;
  const timeoutMinutes = options.timeoutMinutes ?? task.execution_gate.timeout_minutes
    ?? constitution?.constitution.budgets.timeout_minutes ?? 15;
  const adapterOptions: AdapterOptions = { timeoutMinutes, ...(options.adapterOptions ?? {}) };

  const safeDomain = domain.replace(/\//g, '-');
  const attempts: AttemptRecord[] = [];
  let priorNotes = '';
  let passed = false;
  /* What earlier runs of this domain failed on, joined on the constraints this
     task declares. Computed once: it is a property of history, not of the
     attempt, and re-querying per attempt would say the same thing again. */
  const constraintIds = [
    ...(task.context.constitution_articles ?? []),
    ...(spec.requirements ?? []).flatMap((requirement) => requirement.verified_by),
  ];
  const memory = recall(ledger, slug, domain, constraintIds);
  if (memory.known_failures.length) {
    onEvent(`[${adapter}] ${domain} recall: ${memory.known_failures.length} known failure(s) from ${memory.from_runs} prior run(s)`);
  }

  let preview = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const runDir = join(workspaceRoot, 'runs', slug, safeDomain, adapter, `a${attempt}`);
    const worktree = join(workspaceRoot, 'worktrees', slug, `${safeDomain}-${adapter}-a${attempt}`);
    mkdirSync(runDir, { recursive: true });

    const payload = buildPayload({
      domain, attempt, maxAttempts, constitution, spec, task,
      priorNotes, recall: memory.text,
      fixtureRoot: fixtureRoot ? resolve(fixtureRoot) : undefined,
    });
    writeFileSync(join(runDir, 'payload.md'), payload);
    preview = previewCommand(adapter, payload, worktree, runDir, adapterOptions);
    writeFileSync(join(runDir, 'command.txt'), `${preview}\n`);

    if (dryRun) {
      attempts.push({ attempt, worker_exit: null, worker_timed_out: false, worker_ms: 0, gate: null,
        run_dir: runDir, worktree, final_text: '(dry run)', payload_tokens: estimateTokens(payload) });
      break;
    }

    const workspace = createWorkspace(worktree, seed);
    if (workspace.seeded.length) onEvent(`[${adapter}] ${domain} seeded ${workspace.seeded.length} upstream file(s)`);
    if (priorNotes) {
      mkdirSync(join(worktree, '.aose'), { recursive: true });
      writeFileSync(join(worktree, '.aose', 'PROGRESS.md'), priorNotes);
    }

    /* The constraints this run was held to. Recorded on the run rather than
       looked up later, because the blueprint can change and the run cannot. */
    const runId = ledger.startRun(slug, domain, adapter, attempt, runDir, constraintIds);
    onEvent(`[${adapter}] ${domain} attempt ${attempt}/${maxAttempts} — worker starting`);

    const worker = await runWorker(adapter, payload, worktree, runDir, adapterOptions);
    writeFileSync(join(runDir, 'worker.stdout'), worker.stdout);
    writeFileSync(join(runDir, 'worker.stderr'), worker.stderr);

    const parsed = getAdapter(adapter).parse(worker.stdout);
    const finalText = (adapter === 'codex' ? readCodexLastMessage(runDir) : null) ?? parsed.finalText;

    onEvent(`[${adapter}] ${domain} attempt ${attempt} — worker exit ${worker.exit}${worker.timedOut ? ' (timed out)' : ''}, running gate`);
    const gate = await runGate(task.execution_gate.command, worktree, { timeoutMinutes, runDir });

    ledger.finishRun(runId, {
      worker_exit: worker.exit,
      gate_exit: gate.exit_code,
      gate_stdout_sha256: gate.stdout_sha256,
      duration_ms: worker.ms + gate.duration_ms,
      /* The one line worth remembering, on every run rather than only on the
         rare timeout. `recall` reads exactly this field, so a gate that fails
         the ordinary way — the common case — used to teach the next worker
         nothing at all. */
      notes: failureNote(gate, { worktree, attempt, workerTimedOut: worker.timedOut }),
    });

    const progressPath = join(worktree, '.aose', 'PROGRESS.md');
    const progress = existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : '';
    writeFileSync(join(runDir, 'PROGRESS.md'), progress);

    attempts.push({
      attempt, worker_exit: worker.exit, worker_timed_out: worker.timedOut, worker_ms: worker.ms,
      gate, run_dir: runDir, worktree, final_text: finalText, payload_tokens: estimateTokens(payload),
    });

    if (gate.exit_code === 0) {
      onEvent(`[${adapter}] ${domain} attempt ${attempt} — GATE PASS`);
      passed = true;
      if (!keepWorktree) { /* keep the passing tree so converge can inspect it */ }
      break;
    }

    onEvent(`[${adapter}] ${domain} attempt ${attempt} — GATE FAIL (exit ${gate.exit_code})`);
    priorNotes = [
      progress.trim(),
      `Attempt ${attempt} failed the gate (exit ${gate.exit_code}). Gate output tail:`,
      gate.stdout.split('\n').slice(-25).join('\n'),
      gate.stderr.split('\n').slice(-15).join('\n'),
    ].filter(Boolean).join('\n');

    if (!keepWorktree && attempt < maxAttempts) removeWorkspace(worktree);
  }

  return { domain, adapter, passed, attempts, command_preview: preview, exhausted: !passed && !dryRun,
    worktree: attempts.length ? attempts[attempts.length - 1].worktree : '' };
}
