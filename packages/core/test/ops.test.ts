import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFreePosition, snapFrame, planRippleInsert } from '../src/ops.ts';
import type { Clip } from '../src/types.ts';

const c = (id: string, startFrame: number, durationFrames: number): Clip => ({
  id,
  kind: 'component',
  trackId: 't',
  name: id,
  startFrame,
  durationFrames,
  componentName: 'TextOverlay',
  props: {},
});

test('resolveFreePosition', () => {
  assert.deepEqual(resolveFreePosition([], 10, 5), { startFrame: 10, overlapping: false });
  assert.deepEqual(resolveFreePosition([c('a', 0, 100)], 50, 20), { startFrame: 100, overlapping: false });
  assert.deepEqual(resolveFreePosition([c('a', 50, 100)], 45, 20), { startFrame: 30, overlapping: false });
  // crowded: [0,100) [100,200) → desired 50, dur 20 → 200
  assert.deepEqual(resolveFreePosition([c('a', 0, 100), c('b', 100, 100)], 50, 20), { startFrame: 200, overlapping: false });
});

test('snapFrame', () => {
  assert.equal(snapFrame(98, [0, 100, 200], 5), 100);
  assert.equal(snapFrame(90, [0, 100, 200], 5), 90);
});

test('planRippleInsert', () => {
  const plan = planRippleInsert([c('a', 0, 100), c('b', 100, 50)], 40, 10);
  assert.deepEqual(plan.split, { id: 'a', at: 40 });
  assert.deepEqual(plan.shift, [{ id: 'b', newStart: 110 }]);
});
