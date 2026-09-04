import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../widget.js';

test('sums every item', () => {
  assert.equal(total([1, 2, 3]), 6);
});
