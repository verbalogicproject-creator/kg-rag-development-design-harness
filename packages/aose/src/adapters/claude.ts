import { join } from 'node:path';
import type { Adapter, AdapterOptions, AdapterInvocation, AdapterResult } from './types.ts';
import { plainText } from './types.ts';

/**
 * Claude Code headless worker.
 * Flags confirmed against `claude --help` on the host. `--bare` is deliberately
 * not used: it skips keychain reads, which can break subscription auth.
 */
export const claudeAdapter: Adapter = {
  name: 'claude',
  description: 'claude -p, acceptEdits, session persistence off, JSON envelope',
  build(payload: string, worktree: string, _runDir: string, options: AdapterOptions = {}): AdapterInvocation {
    const args = [
      '-p',
      '--no-session-persistence',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash(npm *),Bash(node *),Bash(git *)',
      '--output-format', 'json',
      '--max-turns', String(options.maxTurns ?? 40),
      '--add-dir', worktree,
    ];
    if (options.model) args.push('--model', options.model);
    return { cmd: 'claude', args, stdin: payload, cwd: worktree };
  },
  parse(stdout: string): AdapterResult {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; usage?: Record<string, unknown> };
      if (typeof parsed.result === 'string') return { finalText: parsed.result, usage: parsed.usage };
    } catch { /* fall through */ }
    return plainText(stdout);
  },
};
