/**
 * Worker adapter contract.
 *
 * SWE-agent (arXiv:2405.15793) showed the agent-computer interface is a
 * first-order lever independent of the model, so the surface handed to a worker
 * is defined once here and every CLI conforms to it rather than each dispatch
 * site hand-rolling flags.
 */
export interface AdapterInvocation {
  cmd: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface AdapterResult { finalText: string; usage?: Record<string, unknown>; }

export interface Adapter {
  name: string;
  /** Human-readable note about what this invocation is allowed to do. */
  description: string;
  build(payload: string, worktree: string, runDir: string, options?: AdapterOptions): AdapterInvocation;
  parse(stdout: string): AdapterResult;
}

export interface AdapterOptions {
  timeoutMinutes?: number;
  maxTurns?: number;
  model?: string;
  /** Codex only: fall back from the landlock sandbox, which PRoot can block. */
  bypassSandbox?: boolean;
}

/** Last resort text extraction when a CLI's JSON envelope is not recognized. */
export function plainText(stdout: string): AdapterResult {
  return { finalText: stdout.trim() };
}
