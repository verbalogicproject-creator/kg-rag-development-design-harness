import type { Adapter, AdapterOptions, AdapterInvocation, AdapterResult } from './types.ts';
import { plainText } from './types.ts';

/**
 * Antigravity CLI headless worker (`agy`).
 * Its print-mode default timeout is 5 minutes, well under a realistic build, so
 * the harness always sets --print-timeout from the task's own budget.
 */
export const agyAdapter: Adapter = {
  name: 'agy',
  description: 'agy -p, accept-edits mode, JSON output, explicit print timeout',
  build(payload: string, worktree: string, _runDir: string, options: AdapterOptions = {}): AdapterInvocation {
    const args = ['-p', payload, '--mode', 'accept-edits', '--output-format', 'json',
      '--add-dir', worktree, '--print-timeout', `${options.timeoutMinutes ?? 15}m`];
    if (options.model) args.push('--model', options.model);
    return { cmd: 'agy', args, cwd: worktree };
  },
  parse(stdout: string): AdapterResult {
    try {
      const parsed = JSON.parse(stdout) as { response?: string; result?: string; text?: string };
      const text = parsed.response ?? parsed.result ?? parsed.text;
      if (typeof text === 'string') return { finalText: text };
    } catch { /* fall through */ }
    return plainText(stdout);
  },
};
