import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFreePosition, snapFrame, planRippleInsert, mergeRanges, volumeAt, sourceSecondsToTimeline } from '../src/ops.ts';
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


test('mergeRanges / volumeAt / sourceSecondsToTimeline', () => {
  assert.deepEqual(mergeRanges([{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 40, end: 45 }, { start: 46, end: 50 }], 1), [{ start: 10, end: 30 }, { start: 40, end: 50 }]);
  const kf = [{ frame: 0, gain: 1 }, { frame: 10, gain: 0.2 }, { frame: 20, gain: 1 }];
  assert.equal(volumeAt(kf, 5), 0.6);
  assert.equal(volumeAt(kf, 25), 1);
  assert.equal(volumeAt(undefined, 3), 1);
  assert.deepEqual(sourceSecondsToTimeline({ startFrame: 100, durationFrames: 60, trimBefore: 30 }, 1, 2, 30), { start: 100, end: 130 });
  assert.equal(sourceSecondsToTimeline({ startFrame: 100, durationFrames: 60, trimBefore: 30 }, 0, 0.5, 30), null);
});
