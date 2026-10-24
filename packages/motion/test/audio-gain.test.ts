import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMediaGain, releaseMediaGain } from '../src/player/audio-gain.ts';

test('boosted preview audio uses a gain node and reuses it for lower volumes and remounts', () => {
  const calls: number[] = [];
  let sources = 0, connected = 0;
  class TestContext {
    state = 'running'; currentTime = 0; destination = {};
    createMediaElementSource() { sources++; return { connect() { connected++; }, disconnect() {} }; }
    createGain() { return { gain: { cancelScheduledValues() {}, setValueAtTime(v: number) { calls.push(v); }, setTargetAtTime(v: number) { calls.push(v); } }, connect() {}, disconnect() {} }; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: TestContext });
  try {
    const media = { volume: 1 } as HTMLMediaElement;
    setMediaGain(media, 0.5);
    assert.equal(media.volume, 0.5); assert.equal(sources, 0);
    setMediaGain(media, 1.5);
    assert.equal(media.volume, 1); assert.deepEqual(calls, [1.5]);
    setMediaGain(media, 0.4);
    assert.equal(media.volume, 1); assert.deepEqual(calls, [1.5, 0.4]);
    releaseMediaGain(media);
    setMediaGain(media, 2);
    assert.equal(sources, 1); assert.equal(connected, 2);
    releaseMediaGain(media);
  } finally {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
