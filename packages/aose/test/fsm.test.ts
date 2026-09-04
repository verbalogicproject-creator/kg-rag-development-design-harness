import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import { apply, replay, nextState, legalEvents, attemptBudget, IllegalTransitionError, TRANSITIONS } from '../src/fsm.ts';

const fresh = () => { const ledger = new Ledger(':memory:'); ledger.createProject('p'); return ledger; };

test('the happy path walks init to archived', () => {
  const ledger = fresh();
  for (const event of ['capture', 'ready', 'compile', 'lint', 'review', 'approve', 'dispatch', 'gate_pass', 'converge', 'export', 'archive']) {
    apply(ledger, 'p', event);
  }
  assert.equal(ledger.getProject('p')!.state, 'ARCHIVED');
  assert.equal(replay(ledger, 'p').valid, true);
});

test('an illegal transition throws and names the legal events', () => {
  const ledger = fresh();
  assert.throws(() => apply(ledger, 'p', 'export'), (error: Error) => {
    assert.equal(error.name, 'IllegalTransitionError');
    assert.match(error.message, /Legal events here: capture, ready, abandon/);
    return true;
  });
});

test('dispatch is refused before approval', () => {
  const ledger = fresh();
  apply(ledger, 'p', 'ready'); apply(ledger, 'p', 'compile'); apply(ledger, 'p', 'lint');
  assert.throws(() => apply(ledger, 'p', 'dispatch'), IllegalTransitionError);
});

test('a gate failure keeps the project dispatched and exhaustion blocks it', () => {
  assert.equal(nextState('DISPATCHED', 'gate_fail'), 'DISPATCHED');
  assert.equal(nextState('DISPATCHED', 'exhausted'), 'BLOCKED');
  assert.equal(nextState('BLOCKED', 'respec'), 'COMPILED');
});

test('replay rejects a state that the transition log cannot reach', () => {
  const ledger = fresh();
  apply(ledger, 'p', 'ready');
  ledger.setState('p', 'EXPORTED');           // tamper: jump the queue
  const result = replay(ledger, 'p');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /not reachable by replaying/);
});

test('replay rejects a forged transition row', () => {
  const ledger = fresh();
  ledger.logTransition('p', 'IDEA_DRAFT', 'APPROVED', 'approve', null);
  ledger.setState('p', 'APPROVED');
  assert.equal(replay(ledger, 'p').valid, false);
});

test('the attempt budget bounds the loop the literature leaves open', () => {
  const ledger = fresh();
  assert.deepEqual(attemptBudget(ledger, 'p', 'core/x', 2), { allowed: true, used: 0, remaining: 2 });
  ledger.finishRun(ledger.startRun('p', 'core/x', 'fake', 1, '/d'), { gate_exit: 1 });
  assert.equal(attemptBudget(ledger, 'p', 'core/x', 2).remaining, 1);
  ledger.finishRun(ledger.startRun('p', 'core/x', 'fake', 2, '/d'), { gate_exit: 1 });
  assert.equal(attemptBudget(ledger, 'p', 'core/x', 2).allowed, false);
});

test('every transition target is a state some transition can leave', () => {
  const terminal = new Set(['ARCHIVED', 'ABANDONED']);
  for (const transition of TRANSITIONS) {
    if (terminal.has(transition.to)) continue;
    assert.ok(legalEvents(transition.to).length > 0, `${transition.to} is a dead end`);
  }
});
