import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesToTimecode, parseTimecode, formatDuration } from '../src/timecode.ts';

test('framesToTimecode formats HH:MM:SS:FF', () => {
  assert.equal(framesToTimecode(0, 30), '00:00:00:00');
  assert.equal(framesToTimecode(29, 30), '00:00:00:29');
  assert.equal(framesToTimecode(30, 30), '00:00:01:00');
  assert.equal(framesToTimecode(30 * 135 + 12, 30), '00:02:15:12');
  assert.equal(framesToTimecode(30 * 3600, 30, { showFrames: false }), '01:00:00');
});

test('parseTimecode accepts the documented forms', () => {
  assert.equal(parseTimecode('00:02:15', 30), 135 * 30);
  assert.equal(parseTimecode('00:02:15:12', 30), 135 * 30 + 12);
  assert.equal(parseTimecode('02:15', 30), 135 * 30);
  assert.equal(parseTimecode('02:15.5', 30), 135 * 30 + 15);
  assert.equal(parseTimecode('12.5s', 30), 375);
  assert.equal(parseTimecode('12.5', 30), 375);
  assert.equal(parseTimecode('300f', 30), 300);
  assert.equal(parseTimecode(300, 30), 300);
});

test('parseTimecode rejects garbage', () => {
  assert.throws(() => parseTimecode('abc', 30));
  assert.throws(() => parseTimecode('00:61:00', 30));
  assert.throws(() => parseTimecode('00:00:00:30', 30));
  assert.throws(() => parseTimecode(-1, 30));
});

test('formatDuration', () => {
  assert.equal(formatDuration(45, 30), '1.5s');
  assert.equal(formatDuration(30 * 72, 30), '1m 12s');
});
