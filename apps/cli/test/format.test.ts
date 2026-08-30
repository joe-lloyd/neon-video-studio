import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressBar, table } from '../src/format.ts';

test('progressBar renders 30 cells', () => {
  const bar = progressBar(0.5, 10);
  assert.equal(bar, '[█████░░░░░]  50.0%');
});

test('table aligns columns', () => {
  const t = table([['a', 'bbb'], ['cc', 'd']], ['x', 'y']);
  assert.equal(t.split('\n').length, 4);
  assert.ok(t.includes('cc  d'));
});
