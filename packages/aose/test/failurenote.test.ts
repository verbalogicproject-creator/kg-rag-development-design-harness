/**
 * What a failing gate leaves behind for the next worker.
 *
 * `recall` reads one field — `runs.notes` — and groups prior failures by its
 * first line. Everything here defends that one string: it has to name a cause,
 * and it has to be identical across two attempts at the same cause. The second
 * property is the subtle one, because a worktree path carries the attempt
 * number and would split one recurring failure into N single sightings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureNote, redactRunPaths } from '../src/gate.ts';

const WT = '/root/fable-blue/.aose/worktrees/freelance-dashboard/core-opportunity-fake-a1';

/** A gate result with only the fields failureNote reads. */
function result(patch: Partial<Parameters<typeof failureNote>[0]> = {}) {
  return {
    command: 'node --test test/opportunity.test.js',
    exit_code: 1, timed_out: false, stdout: '', stderr: '', ...patch,
  };
}

test('the observed failure becomes the note', () => {
  // Verbatim from .aose/runs/freelance-dashboard/core-opportunity/fake/a1.
  const note = failureNote(result({ stderr: "Could not find 'test/opportunity.test.js'\n" }), { worktree: WT });
  assert.equal(note, "Could not find 'test/opportunity.test.js'");
});

test('two attempts at one cause produce one identical note', () => {
  // The property recall depends on. An assertion failure names the file it
  // failed in, and that path differs between attempts by exactly `-a1`/`-a2`.
  const stderrFor = (n: number) => [
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    `    at file:///root/fable-blue/.aose/worktrees/freelance-dashboard/core-opportunity-fake-a${n}/test/x.test.js:12:3`,
  ].join('\n');

  const a1 = failureNote(result({ stderr: stderrFor(1) }), { worktree: `${WT}` });
  const a2 = failureNote(result({ stderr: stderrFor(2) }),
    { worktree: WT.replace('-a1', '-a2') });

  assert.equal(a1, a2, 'the same cause must group as one failure, not two');
  assert.match(a1, /Expected values to be strictly equal/);
});

test('a path from a run this one never knew is still redacted', () => {
  // Output can quote a path from another attempt — a diff, a cached message.
  // Redaction cannot rely on being handed the right worktree.
  const note = redactRunPaths(
    'compared /root/x/.aose/worktrees/p/d-claude-a7/src/a.js with b',
    undefined,
  );
  assert.equal(note, 'compared <worktree>/src/a.js with b');
});

test('the known worktree is redacted even where the pattern cannot reach', () => {
  // Two mechanisms, and this is the only case that separates them. `\S*` stops
  // at a space, so a repo under `/root/my projects/` leaves a fragment behind
  // when only the generic pattern runs. Grouping survives either way — the
  // varying `-aN` is inside the redacted span — so this is about a legible
  // note, not a correct one, and it is why the explicit split stays.
  const wt = '/root/my projects/fb/.aose/worktrees/p/core-fake-a1';
  const line = `AssertionError at ${wt}/test/x.test.js:12`;

  assert.equal(redactRunPaths(line, wt), 'AssertionError at <worktree>/test/x.test.js:12');
  assert.equal(redactRunPaths(line), 'AssertionError at /root/my <worktree>/test/x.test.js:12');

  const a2 = line.replace('-a1', '-a2');
  assert.equal(redactRunPaths(line), redactRunPaths(a2), 'grouping must hold without the worktree too');
});

test('stack frames are skipped in favour of the message', () => {
  const note = failureNote(result({
    stderr: ['    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
             '    at foo (/tmp/x.js:1:1)',
             'TypeError: engine.play is not a function'].join('\n'),
  }));
  assert.equal(note, 'TypeError: engine.play is not a function');
});

test('an assertion on stdout is found when stderr is silent', () => {
  // node --test reports assertion failures through TAP on stdout.
  const note = failureNote(result({
    stdout: ['TAP version 13', '# Subtest: plays a move', 'not ok 1 - plays a move', '  ---'].join('\n'),
  }));
  assert.equal(note, 'not ok 1 - plays a move');
});

test('the runner summary never wins over the failure itself', () => {
  // `# fail 3` is a count, not a cause. The marker line has to be preferred or
  // recall carries a number where it needs a reason.
  const note = failureNote(result({
    stdout: ['# tests 4', 'not ok 2 - rejects a taken cell', '# pass 1', '# fail 3'].join('\n'),
  }));
  assert.equal(note, 'not ok 2 - rejects a taken cell');
});

test('a gate that fails silently says exactly that', () => {
  // Reporting nothing is honest; inventing a cause from an exit code is not.
  assert.equal(failureNote(result({ exit_code: 2 })), 'gate exited 2 with no diagnostic output');
});

test('a pass records its test count only when the output has one', () => {
  const counted = failureNote(result({ exit_code: 0, stdout: '# pass 24\n# fail 0\n' }), { attempt: 2 });
  assert.equal(counted, 'gate passed on attempt 2 — 24 test(s) via `node --test test/opportunity.test.js`');

  const uncounted = failureNote(result({ exit_code: 0, stdout: 'ok\n' }), { attempt: 1 });
  assert.equal(uncounted, 'gate passed on attempt 1 via `node --test test/opportunity.test.js`');
});

test('a timed-out worker outranks a timed-out gate', () => {
  // A gate that ran against a half-finished worktree tells you about the
  // worker, not the code. Naming the gate would point at the wrong thing.
  const note = failureNote(result({ timed_out: true }), { workerTimedOut: true });
  assert.equal(note, 'worker timed out before the gate ran');
  assert.match(failureNote(result({ timed_out: true })), /^gate timed out/);
});

test('a note stays inside the budget recall slices to', () => {
  // recall truncates at 160 chars. Producing a longer line would mean the
  // grouping key is a prefix, and two different failures sharing a long prefix
  // would silently merge into one.
  const note = failureNote(result({ stderr: `Error: ${'x'.repeat(500)}` }));
  assert.ok(note.length <= 160, `note was ${note.length} chars`);
});
