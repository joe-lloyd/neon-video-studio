import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStartRequestSchema } from '@neon/core';
import { captureStartBody, describeState } from '../src/capture.ts';

test('capture flags become a start request the server accepts', () => {
  const body = captureStartBody({ display: '1', region: '0,0,1280,720', fps: '60', 'no-mic': true, cursor: false });
  assert.deepEqual(body, { display: 1, region: '0,0,1280,720', window: undefined, fps: 60, mic: false, cursor: false });
  assert.deepEqual(CaptureStartRequestSchema.parse(body), {
    source: { kind: 'region', display: 1, rect: { x: 0, y: 0, width: 1280, height: 720 } },
    mic: { kind: 'none' },
    fps: 60,
    cursor: false,
  });
});

test('--no-mic works whether Node reports it as no-mic or as mic=false', () => {
  assert.equal(captureStartBody({ mic: false }).mic, false);
  assert.equal(captureStartBody({ mic: 'RODE' }).mic, 'RODE');
  assert.equal(captureStartBody({}).mic, undefined);
  assert.throws(() => captureStartBody({ mic: 'RODE', 'no-mic': true }), /not both/);
  assert.throws(() => captureStartBody({ display: '-1' }), /--display expects a whole number ≥ 0/);
});

test('status lines say what is being recorded', () => {
  assert.equal(describeState({ status: 'idle' }), 'Not recording the screen');
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  assert.equal(
    describeState({ status: 'recording', startedAt, source: { kind: 'window', title: 'Code' }, mic: null, encoder: 'h264_nvenc', fps: 30 }),
    'Recording window “Code” for 1:05 · mic off · h264_nvenc @ 30 fps',
  );
});
