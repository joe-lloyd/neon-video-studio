import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from '../src/interpolate.ts';
import { Easing, bezier } from '../src/easing.ts';
import { spring, measureSpring } from '../src/spring.ts';
import { interpolateColors, parseColor } from '../src/color.ts';
import { random } from '../src/random.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('interpolate maps linearly and extrapolates by default', () => {
  close(interpolate(5, [0, 10], [0, 100]), 50);
  close(interpolate(15, [0, 10], [0, 100]), 150);
  close(interpolate(-5, [0, 10], [100, 0]), 150);
});

test('interpolate clamps, passes through and wraps', () => {
  const opts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
  close(interpolate(-3, [0, 10], [0, 1], opts), 0);
  close(interpolate(30, [0, 10], [0, 1], opts), 1);
  close(interpolate(30, [0, 10], [0, 1], { extrapolateRight: 'identity' }), 30);
  close(interpolate(12, [0, 10], [0, 100], { extrapolateRight: 'wrap' }), 20);
  close(interpolate(-2, [0, 10], [0, 100], { extrapolateLeft: 'wrap' }), 80);
});

test('interpolate handles multi-segment ranges and easing per segment', () => {
  close(interpolate(15, [0, 10, 20], [0, 1, 0]), 0.5);
  close(interpolate(5, [0, 10, 20], [0, 100, 0], { easing: Easing.quad }), 25);
  close(interpolate(10, [0, 10, 20], [0, 100, 0]), 100);
});

test('interpolate rejects bad ranges', () => {
  assert.throws(() => interpolate(1, [0, 0], [0, 1]), /strictly increasing/);
  assert.throws(() => interpolate(1, [0, 1, 2], [0, 1]), /same length/);
  assert.throws(() => interpolate(Number.NaN, [0, 1], [0, 1]), /must be a number/);
});

test('Easing endpoints are fixed and composition helpers work', () => {
  for (const fn of [Easing.linear, Easing.ease, Easing.quad, Easing.cubic, Easing.sin, Easing.circle, Easing.bounce, Easing.elastic(1), Easing.back(), bezier(0.38, 1.21, 0.22, 1)]) {
    close(fn(0), 0, 1e-3);
    close(fn(1), 1, 1e-3);
  }
  close(Easing.out(Easing.quad)(0.5), 0.75);
  close(Easing.inOut(Easing.quad)(0.25), 0.125);
  close(Easing.poly(4)(0.5), 0.0625);
});

test('bezier matches known CSS curves', () => {
  const ease = bezier(0.25, 0.1, 0.25, 1);
  close(ease(0.5), 0.8024033877399112, 1e-4);
  const linear = bezier(0.5, 0.5, 0.5, 0.5);
  close(linear(0.3), 0.3);
  // Overshooting expressive curve exceeds 1 mid-way.
  assert.ok(bezier(0.38, 1.21, 0.22, 1)(0.6) > 1);
  assert.throws(() => bezier(1.2, 0, 0, 1));
});

test('spring starts at from, settles at to and is frame-deterministic', () => {
  const fps = 30;
  close(spring({ frame: 0, fps }), 0);
  close(spring({ frame: 300, fps }), 1, 1e-3);
  // Under-damped default overshoots.
  const peak = Math.max(...Array.from({ length: 60 }, (_, f) => spring({ frame: f, fps })));
  assert.ok(peak > 1.01, `expected overshoot, got ${peak}`);
  // Clamped never exceeds the target.
  const clamped = Math.max(...Array.from({ length: 60 }, (_, f) => spring({ frame: f, fps, config: { overshootClamping: true } })));
  assert.ok(clamped <= 1);
  // Same input → same output regardless of evaluation order.
  close(spring({ frame: 17, fps }), spring({ frame: 17, fps }));
  close(spring({ frame: 10, fps, from: 50, to: 100 }), 50 + 50 * spring({ frame: 10, fps }));
});

test('spring respects delay, durationInFrames and reverse', () => {
  const fps = 30;
  close(spring({ frame: 5, fps, delay: 10 }), 0);
  const d = 20;
  close(spring({ frame: d, fps, durationInFrames: d }), 1, 0.01);
  close(spring({ frame: 0, fps, durationInFrames: d, reverse: true }), 1, 0.01);
  close(spring({ frame: d, fps, durationInFrames: d, reverse: true }), 0, 1e-9);
  const n = measureSpring({ fps, config: { damping: 20 } }); // critically damped
  assert.ok(n > 5 && n < 120, `unexpected settle time ${n}`);
  assert.ok(measureSpring({ fps, config: { damping: 5 } }) > n, 'less damping settles later');
});

test('critically and over-damped springs behave', () => {
  const crit = spring({ frame: 15, fps: 30, config: { damping: 20, stiffness: 100, mass: 1 } });
  const over = spring({ frame: 15, fps: 30, config: { damping: 60, stiffness: 100, mass: 1 } });
  assert.ok(crit > 0 && crit < 1 && over > 0 && over < crit);
});

test('parseColor and interpolateColors', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#00000080').map((v) => Math.round(v * 100) / 100), [0, 0, 0, 0.5]);
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1]);
  assert.deepEqual(parseColor('rgba(10 20 30 / 0.5)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)').map(Math.round), [255, 0, 0, 1]);
  assert.equal(interpolateColors(5, [0, 10], ['#000000', '#ffffff']), 'rgba(128, 128, 128, 1)');
  assert.equal(interpolateColors(20, [0, 10], ['red', 'blue']), 'rgba(0, 0, 255, 1)');
  assert.throws(() => parseColor('not-a-colour'));
});

test('random is deterministic and in [0, 1)', () => {
  assert.equal(random(1), random(1));
  assert.equal(random('seed'), random('seed'));
  assert.notEqual(random(1), random(2));
  for (let i = 0; i < 1000; i++) {
    const v = random(i);
    assert.ok(v >= 0 && v < 1);
  }
  assert.throws(() => random(null));
});
