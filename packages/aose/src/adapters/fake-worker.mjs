/**
 * Offline fixture worker.
 *
 * Reads the same payload a real CLI would receive on stdin, extracts the
 * deliverables and the fixture root the harness embedded in it, copies the
 * fixture files in, appends to the progress log, and prints the same
 * `GATE: ...` final line the protocol asks a real worker for. It never runs
 * the gate itself: the harness does that, so the evidence is produced rather
 * than claimed (Alfredvc/aharness).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , worktree] = process.argv;
const payload = readFileSync(0, 'utf8');

const fixtureMatch = /<!-- aose:fixture_root=(.+?) -->/.exec(payload);
const attemptMatch = /attempt (\d+) of \d+/.exec(payload);
const attempt = attemptMatch ? Number(attemptMatch[1]) : 1;
const deliverables = [...payload.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]);

const written = [];
if (fixtureMatch) {
  // A fixture may model a worker that improves between attempts by providing
  // attempt-<n>/ subdirectories. Without them every attempt gets the same files.
  const base = fixtureMatch[1];
  const perAttempt = join(base, `attempt-${attempt}`);
  const fixtureRoot = existsSync(perAttempt) ? perAttempt : base;
  for (const file of deliverables) {
    const from = join(fixtureRoot, file);
    if (!existsSync(from)) continue;
    const to = join(worktree, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    written.push(file);
  }
}

const progressPath = join(worktree, '.aose', 'PROGRESS.md');
mkdirSync(dirname(progressPath), { recursive: true });
const existing = existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : '';
writeFileSync(progressPath, `${existing}- fake worker materialized ${written.length} deliverable(s): ${written.join(', ') || 'none'}\n`);

process.stdout.write(`GATE: PASS — ${written.join(', ') || 'no files'}\n`);
