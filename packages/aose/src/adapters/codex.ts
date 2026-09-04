import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Adapter, AdapterOptions, AdapterInvocation, AdapterResult } from './types.ts';
import { plainText } from './types.ts';

/**
 * Codex CLI headless worker (`codex exec`).
 * `--sandbox workspace-write` is the default; under PRoot the landlock sandbox
 * can fail to initialize, so `bypassSandbox` swaps in the bypass flag. The git
 * worktree remains the real isolation boundary either way.
 */
export const codexAdapter: Adapter = {
  name: 'codex',
  description: 'codex exec, workspace-write sandbox, JSONL events, last message to file',
  build(payload: string, worktree: string, runDir: string, options: AdapterOptions = {}): AdapterInvocation {
    const args = ['exec', '-C', worktree, '--skip-git-repo-check', '--ephemeral', '--json',
      '-o', join(runDir, 'last-message.md')];
    if (options.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write');
    if (options.model) args.push('--model', options.model);
    args.push('-');
    return { cmd: 'codex', args, stdin: payload, cwd: worktree };
  },
  parse(stdout: string): AdapterResult {
    const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const event = JSON.parse(lines[i]) as { msg?: { type?: string; message?: string }; type?: string; message?: string };
        const message = event.msg?.message ?? event.message;
        const type = event.msg?.type ?? event.type;
        if (message && (type === 'agent_message' || type === 'task_complete')) return { finalText: message };
      } catch { /* skip malformed line */ }
    }
    return plainText(stdout);
  },
};

/** Codex writes its final message to a file; prefer it when present. */
export function readCodexLastMessage(runDir: string): string | null {
  const path = join(runDir, 'last-message.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
