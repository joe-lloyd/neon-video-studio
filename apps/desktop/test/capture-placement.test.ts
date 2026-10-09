import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clip, Track } from '@neon/core';
import { capturePlacement } from '../src/main/screen-recorder.ts';

const track = (id: string, name: string, kind: Track['kind'], order: number): Track => ({ id, name, kind, order, muted: false, locked: false, hidden: false });
const clip = (id: string, trackId: string, startFrame: number, durationFrames: number): Clip => ({ id, trackId, name: id, kind: 'video', assetId: 'a', startFrame, durationFrames, trimBefore: 0, volume: 1 });

const tracks = [track('t-fx', 'FX1', 'overlay', 0), track('t-v1', 'V1', 'video', 1), track('t-v2', 'V2', 'video', 2), track('t-a1', 'A1', 'audio', 3)];
const clips = [clip('c1', 't-v1', 0, 90), clip('c2', 't-v1', 120, 60), clip('c3', 't-v2', 0, 900)];

test('successive takes append to the end of V1', () => {
  assert.deepEqual(capturePlacement({ tracks, clips }, {}), { trackId: 't-v1', startFrame: 180 });
});

test('--at and --track override the default placement', () => {
  assert.deepEqual(capturePlacement({ tracks, clips }, { at: 30 }), { trackId: 't-v1', startFrame: 30 });
  assert.deepEqual(capturePlacement({ tracks, clips }, { track: 'v2' }), { trackId: 't-v2', startFrame: 900 });
  assert.deepEqual(capturePlacement({ tracks, clips }, { track: 't-fx', at: 15 }), { trackId: 't-fx', startFrame: 15 });
  assert.throws(() => capturePlacement({ tracks, clips }, { track: 'A1' }), /A1 is an audio track/);
  assert.throws(() => capturePlacement({ tracks, clips }, { track: 'nope' }), /Track nope not found/);
});

test('a project without a video track asks for a new V1 at frame 0', () => {
  assert.deepEqual(capturePlacement({ tracks: [track('t-a1', 'A1', 'audio', 0)], clips: [] }, {}), { trackId: null, startFrame: 0 });
});
