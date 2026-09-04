import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Adapter, AdapterInvocation, AdapterResult } from './types.ts';

/**
 * Deterministic offline worker.
 *
 * Copies a fixture implementation into the task's deliverables. It exists so
 * the whole pipeline — attempt loop, bounds, progress log, gate, converge — can
 * be proven in CI and in tests without spending a single model token. The real
 * adapters differ only in which process writes the files.
 */
export const fakeAdapter: Adapter = {
  name: 'fake',
  description: 'offline fixture worker used by tests and `npm run proof`',
  build(payload: string, worktree: string, runDir: string): AdapterInvocation {
    const script = resolve(import.meta.dirname, 'fake-worker.mjs');
    return { cmd: process.execPath, args: [script, worktree, runDir], stdin: payload, cwd: worktree };
  },
  parse(stdout: string): AdapterResult {
    return { finalText: stdout.trim() };
  },
};

/** Copy fixture files into a worktree; used by the fake worker process. */
export function materialize(fixtureDir: string, worktree: string, files: string[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const from = join(fixtureDir, file);
    if (!existsSync(from)) continue;
    const to = join(worktree, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    written.push(file);
  }
  return written;
}

export function appendProgress(worktree: string, text: string): void {
  const path = join(worktree, '.aose', 'PROGRESS.md');
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, `${existing}${text}\n`);
}
