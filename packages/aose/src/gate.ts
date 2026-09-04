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
import { writeFileSync, mkdirSync } from 'node:fs';
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
