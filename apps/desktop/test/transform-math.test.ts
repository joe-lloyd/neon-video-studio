import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchoredTransform, positionForCenter, projectCenter, type NaturalBox, type Transform } from '../src/renderer/lib/transform-math.ts';

const W = 1920;
const H = 1080;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('positionForCenter inverts projectCenter for off-centre, scaled and rotated elements', () => {
  const boxes: NaturalBox[] = [
    { cx: 0.5, cy: 0.5, w: 1, h: 1 },
    { cx: 0.2, cy: 0.85, w: 0.3, h: 0.1 }, // lower-third style
    { cx: 0.9, cy: 0.1, w: 0.1, h: 0.1 },
  ];
  const transforms: Transform[] = [
    { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    { x: 0.62, y: 0.4, scale: 1.7, rotation: 33 },
    { x: 0.3, y: 0.7, scale: 0.4, rotation: -120 },
  ];
  for (const nat of boxes) {
    for (const t of transforms) {
      const c = projectCenter(nat, t, W, H);
      const pos = positionForCenter(nat, t, c.cx, c.cy, W, H);
      near(pos.x, t.x);
      near(pos.y, t.y);
    }
  }
});

test('anchoredTransform keeps the painted centre fixed while scaling and rotating', () => {
  const nat: NaturalBox = { cx: 0.2, cy: 0.85, w: 0.3, h: 0.1 };
  const start: Transform = { x: 0.55, y: 0.45, scale: 1, rotation: 0 };
  const before = projectCenter(nat, start, W, H);
  const scaled = anchoredTransform(nat, start, { scale: 2.5 }, W, H);
  const afterScale = projectCenter(nat, scaled, W, H);
  near(afterScale.cx, before.cx);
  near(afterScale.cy, before.cy);
  assert.equal(scaled.scale, 2.5);
  const rotated = anchoredTransform(nat, scaled, { rotation: 72 }, W, H);
  const afterRotate = projectCenter(nat, rotated, W, H);
  near(afterRotate.cx, before.cx);
  near(afterRotate.cy, before.cy);
  assert.equal(rotated.rotation, 72);
  // Without anchoring, the same scale change would have dragged the centre away (that was the bug).
  const naive = projectCenter(nat, { ...start, scale: 2.5 }, W, H);
  assert.ok(Math.hypot(naive.cx - before.cx, naive.cy - before.cy) > 100);
});
