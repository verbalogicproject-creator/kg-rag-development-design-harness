import type { Adapter, AdapterOptions, AdapterInvocation, AdapterResult } from './types.ts';
import { plainText } from './types.ts';

/**
 * Gemini CLI headless worker.
 * `--sandbox` is never passed: it requires a container runtime this host does
 * not have, and would silently change the execution semantics.
 */
export const geminiAdapter: Adapter = {
  name: 'gemini',
  description: 'gemini -p, yolo approval, JSON output, workspace scoped',
  build(payload: string, worktree: string, _runDir: string, options: AdapterOptions = {}): AdapterInvocation {
    const args = ['-p', payload, '--approval-mode', 'yolo', '-o', 'json', '--include-directories', worktree];
    if (options.model) args.push('-m', options.model);
    return { cmd: 'gemini', args, cwd: worktree };
  },
  parse(stdout: string): AdapterResult {
    try {
      const parsed = JSON.parse(stdout) as { response?: string; result?: string };
      const text = parsed.response ?? parsed.result;
      if (typeof text === 'string') return { finalText: text };
    } catch { /* fall through */ }
    return plainText(stdout);
  },
};
