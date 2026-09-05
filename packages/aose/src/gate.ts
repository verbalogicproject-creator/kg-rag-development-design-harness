/**
 * Execution gate runner.
 *
 * Both source harnesses declared an `execution_gate` and neither ever ran one.
 * Running it here is the whole point: the exit code and a hash of the output
 * are recorded by the harness, so "the tests pass" is evidence the harness
 * produced rather than a claim the worker made about itself.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GateResult {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_sha256: string;
  log_path: string;
}

export interface GateOptions { timeoutMinutes?: number; runDir?: string; env?: Record<string, string>; }

/**
 * Build the child environment for a gate or a worker.
 *
 * A gate must actually run. `node:test` sets NODE_TEST_CONTEXT in its children,
 * and a nested `node --test` seeing it prints "skipping running files" and
 * exits 0 — a gate that passes without executing a single test. Inheriting a
 * parent's test context would therefore manufacture exactly the false evidence
 * this harness exists to prevent, so it is stripped here rather than trusted.
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ...extra } as Record<string, string>;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (env.NODE_OPTIONS) {
    const stripped = env.NODE_OPTIONS.replace(/--test(-[\w-]+)?(=\S+)?/g, '').replace(/\s+/g, ' ').trim();
    if (stripped) env.NODE_OPTIONS = stripped; else delete env.NODE_OPTIONS;
  }
  return env;
}

export async function runGate(command: string, cwd: string, options: GateOptions = {}): Promise<GateResult> {
  const timeoutMs = (options.timeoutMinutes ?? 15) * 60_000;
  const started = Date.now();

  /* Refuse before spawning, rather than let the command resolve somewhere the
     worker never touched. A gate that runs outside its worktree can report a
     pass earned by another project's files. */
  const escape = gateEscapesWorktree(command, cwd);
  if (escape) {
    const stderr = `aose: gate refused — ${escape}\n`;
    if (options.runDir) {
      mkdirSync(options.runDir, { recursive: true });
      writeFileSync(join(options.runDir, 'gate.log'),
        `$ ${command}\ncwd: ${cwd}\nexit: 1 (refused before spawning)\n\n--- stderr ---\n${stderr}`);
    }
    return {
      command, exit_code: 1, timed_out: false, duration_ms: 0,
      stdout: '', stderr,
      stdout_sha256: createHash('sha256').update('').digest('hex'),
      log_path: options.runDir ? join(options.runDir, 'gate.log') : '',
    };
  }

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: cleanEnv({ ...(options.env ?? {}), CI: '1' }),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${(error as Error).message}`, timedOut });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

  const duration = Date.now() - started;
  const stdoutSha = createHash('sha256').update(result.stdout).digest('hex');
  let logPath = '';
  if (options.runDir) {
    mkdirSync(options.runDir, { recursive: true });
    logPath = join(options.runDir, 'gate.log');
    writeFileSync(logPath, [
      `$ ${command}`,
      `cwd: ${cwd}`,
      `exit: ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
      `duration_ms: ${duration}`,
      `stdout_sha256: ${stdoutSha}`,
      '--- stdout ---', result.stdout,
      '--- stderr ---', result.stderr,
    ].join('\n'));
  }

  return {
    command,
    exit_code: result.timedOut ? null : result.code,
    timed_out: result.timedOut,
    duration_ms: duration,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_sha256: stdoutSha,
    log_path: logPath,
  };
}

/* ------------------------------------------------------------------ */
/* Turning a gate result into one line worth remembering.              */
/* ------------------------------------------------------------------ */

/** Lines that are structure, not diagnosis — a stack frame says where, not what. */
const NOISE = /^\s*(at\s|node:internal|\^+\s*$|Node\.js v|\s*$)/;
/** Where a test runner announces the failure itself rather than the summary. */
const STDOUT_SIGNAL = /^\s*(not ok\b|error:|AssertionError|# fail\b|FAIL\b|✗|×)/;

/**
 * Strip anything that varies between two runs of the same failure.
 *
 * The worktree path ends in `-a<N>`, so leaving it in makes attempt 1 and
 * attempt 2 of one cause look like two causes. `recall` groups by this exact
 * string, so a leaked path would hold `seen_in` at 1 forever and quietly turn
 * "this fails every time" into "this happened once, twice".
 */
export function redactRunPaths(line: string, worktree?: string): string {
  let out = line;
  if (worktree) {
    out = out.split(worktree).join('<worktree>');
    out = out.split(`file://${worktree}`).join('<worktree>');
  }
  /* Any other attempt-numbered worktree, including one from a prior run whose
     path this run never knew. */
  out = out.replace(/(?:file:\/\/)?\S*[/\\]\.aose[/\\]worktrees[/\\]\S*?-a\d+/g, '<worktree>');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The single most informative line about why a gate failed, or how it passed.
 *
 * This is what `recall` carries to the next cold worker, so it has to be a
 * cause rather than a restatement of the exit code. Deterministic and
 * framework-tolerant: a count is reported only when the output actually
 * contains one, never inferred.
 */
export function failureNote(
  gate: Pick<GateResult, 'exit_code' | 'timed_out' | 'stdout' | 'stderr' | 'command'>,
  options: { worktree?: string; attempt?: number; workerTimedOut?: boolean } = {},
): string {
  const { worktree, attempt } = options;
  const clean = (line: string) => redactRunPaths(line, worktree).slice(0, 160);

  /* The gate still runs after a worker timeout — against a worktree the worker
     never finished filling. Measured: ui/client timed out at 900s and its gate
     then failed in 5.6s on `Missing script: "build"`, which describes the
     unfinished worktree rather than the design. Saying the gate did not run
     would put a false statement into the next worker's recall. */
  if (options.workerTimedOut) {
    return gate.exit_code === 0
      ? 'worker timed out, but the gate passed on what it had written'
      : `worker timed out; the gate then ran against an unfinished worktree and exited ${gate.exit_code ?? 'null'}`;
  }
  if (gate.timed_out) return `gate timed out running \`${gate.command}\``;

  if (gate.exit_code === 0) {
    /* Both of node --test's reporters. The TAP form is `# pass 6`; the spec
       reporter, which is what the harness actually captures, writes `ℹ pass 6`.
       Matching only TAP looked correct under a TAP fixture and never fired on
       a real run — the count was silently absent from every pass note. */
    const count = /^[#\u2139]\s*pass\s+(\d+)/m.exec(gate.stdout)?.[1];
    const where = attempt ? ` on attempt ${attempt}` : '';
    return count
      ? `gate passed${where} — ${count} test(s) via \`${gate.command}\``
      : `gate passed${where} via \`${gate.command}\``;
  }

  /* stderr first: a module that would not load, a syntax error, a crash. Those
     are the failures a worker most needs told, and they never reach stdout. */
  for (const line of gate.stderr.split('\n')) {
    if (NOISE.test(line)) continue;
    const text = clean(line);
    if (text) return text;
  }
  /* Then the runner's own failure markers on stdout. A TAP summary line is a
     count of failures, not a reason, so the marker lines come first. */
  for (const line of gate.stdout.split('\n')) {
    if (!STDOUT_SIGNAL.test(line)) continue;
    const text = clean(line);
    if (text) return text;
  }
  return `gate exited ${gate.exit_code ?? 'null'} with no diagnostic output`;
}

/**
 * Whether a gate command would run outside the worktree it was given.
 *
 * npm resolves `package.json` by walking up the directory tree. The worktrees
 * live inside the repository, so a gate that runs `npm run <script>` in a
 * worktree that has no package.json of its own finds the MONOREPO ROOT and
 * runs the harness's scripts. Measured: `npm run` in an empty worktree prints
 * "Lifecycle scripts included in fable-blue@0.2.0" and lists this repository's
 * own commands.
 *
 * The danger is not the error it produced here — that was luck, because the
 * root happens to define no `build`. A task whose gate is `npm run test` would
 * have run the harness's entire suite from the repository root and could exit
 * 0, producing a passing gate from evidence the worker never created. That is
 * precisely the failure this harness exists to prevent, so the gate refuses to
 * run rather than risk reporting it.
 */
export function gateEscapesWorktree(command: string, worktree: string): string | null {
  if (!/\bnpm\b/.test(command)) return null;
  if (existsSync(join(worktree, 'package.json'))) return null;
  return 'the gate runs npm but the worktree has no package.json, so npm would walk up out of the '
    + 'worktree and run the enclosing project\'s scripts. The worker has not produced the file its '
    + 'gate depends on; a result from here would not be about this domain.';
}
