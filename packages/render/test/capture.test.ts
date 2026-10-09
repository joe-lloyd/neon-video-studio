import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFrames, parseCapture } from '../src/capture.ts';

test('a still request resolves its time and default width', () => {
  const r = parseCapture('still', { at: '1.5s' }, 30, 120);
  assert.deepEqual(r, { target: { kind: 'still', frame: 45, width: 1280 }, output: undefined });
  assert.deepEqual(captureFrames(r.target), [45]);
});

test('a sheet request resolves every, cols and output', () => {
  const r = parseCapture('sheet', { every: '1s', cols: 2, width: 800, output: '/tmp/s.png' }, 30, 120);
  assert.deepEqual(r, { target: { kind: 'sheet', frames: [0, 30, 60, 90], cols: 2, width: 800 }, output: '/tmp/s.png' });
  assert.deepEqual(captureFrames(r.target), [0, 30, 60, 90]);
});

test('bad requests are rejected at the boundary', () => {
  assert.throws(() => parseCapture('still', {}, 30, 120));
  assert.throws(() => parseCapture('still', { at: '5s' }, 30, 120), /past the end/);
  assert.throws(() => parseCapture('sheet', { count: 0 }, 30, 120));
  assert.throws(() => parseCapture('sheet', { width: 100 }, 30, 120));
});
