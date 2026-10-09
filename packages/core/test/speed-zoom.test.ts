import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDoc, sourceFrameAt, timelineFrameAt, volumeAt, zoomAt, type MediaClip } from '../src/index.ts';

function project(): { doc: ProjectDoc; assetId: string } {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ name: 't', fps: 30, width: 1920, height: 1080 });
  const assetId = 'a'.repeat(64);
  doc.addAsset({ id: assetId, name: 'take.mp4', kind: 'video', mime: 'video/mp4', size: 1, durationFrames: 600, importedAt: '2026-01-01T00:00:00Z' });
  return { doc, assetId };
}

function media(doc: ProjectDoc, id: string): MediaClip {
  const c = doc.getClip(id);
  assert.ok(c && c.kind !== 'component');
  return c;
}

test('splitting keeps volume automation on the same timeline frames', () => {
  const { doc, assetId } = project();
  const clip = doc.insertClip({ kind: 'video', assetId, startFrame: 0, durationFrames: 120 });
  doc.updateClip(clip.id, { volumeKeyframes: [{ frame: 0, gain: 1 }, { frame: 40, gain: 1 }, { frame: 50, gain: 0 }, { frame: 70, gain: 0 }, { frame: 80, gain: 1 }] });
  const gainAt = (f: number) => {
    const c = doc.toJSON().clips.find((x) => x.kind !== 'component' && x.startFrame <= f && f < x.startFrame + x.durationFrames) as MediaClip;
    return volumeAt(c.volumeKeyframes, f - c.startFrame);
  };
  const before = [10, 45, 55, 60, 75, 90].map(gainAt);
  doc.splitClip(clip.id, 60);
  assert.deepEqual([10, 45, 55, 60, 75, 90].map(gainAt), before);
});

test('slowing a clip down lengthens it and pushes later clips right', () => {
  const { doc, assetId } = project();
  const a = doc.insertClip({ kind: 'video', assetId, startFrame: 0, durationFrames: 120 });
  const b = doc.insertClip({ kind: 'video', assetId, startFrame: 120, durationFrames: 30, placement: 'overlap' });
  doc.setClipSpeed(a.id, 0.5);
  assert.equal(media(doc, a.id).durationFrames, 240);
  assert.equal(media(doc, b.id).startFrame, 240);
});

test('speeding up a range splits the clip and closes the gap on every track', () => {
  const { doc, assetId } = project();
  const a = doc.insertClip({ kind: 'video', assetId, startFrame: 0, durationFrames: 120 });
  const title = doc.insertClip({ kind: 'component', componentName: 'TextOverlay', startFrame: 100, durationFrames: 30 });
  const fast = doc.setClipSpeed(a.id, 4, { start: 30, end: 90 });
  const clips = doc.toJSON().clips.filter((c): c is MediaClip => c.kind === 'video').sort((x, y) => x.startFrame - y.startFrame);
  assert.deepEqual(
    clips.map((c) => [c.startFrame, c.durationFrames, c.trimBefore, c.speed ?? 1]),
    [
      [0, 30, 0, 1],
      [30, 15, 30, 4],
      [45, 30, 90, 1],
    ],
  );
  assert.equal(fast.speed, 4);
  assert.equal(doc.getClip(title.id)?.startFrame, 55);
});

test('source and timeline frames convert through speed and trim', () => {
  const clip = { startFrame: 100, durationFrames: 50, trimBefore: 30, speed: 2 };
  assert.equal(sourceFrameAt(clip, 110), 50);
  assert.equal(timelineFrameAt(clip, 50), 110);
  assert.equal(timelineFrameAt(clip, 10), null);
  assert.equal(timelineFrameAt(clip, 130), null);
});

test('splitting a sped-up clip advances the source by the consumed frames', () => {
  const { doc, assetId } = project();
  const a = doc.insertClip({ kind: 'video', assetId, startFrame: 0, durationFrames: 120 });
  doc.setClipSpeed(a.id, 2);
  const [, right] = doc.splitClip(a.id, 20);
  assert.equal(right.kind !== 'component' && right.trimBefore, 40);
  assert.equal(right.kind !== 'component' && right.speed, 2);
});

test('zoom eases in, holds, eases out and stays inside the frame', () => {
  const zooms = [{ start: 100, end: 200, cx: 0.9, cy: 0.5, zoom: 2, ramp: 20 }];
  assert.deepEqual(zoomAt(zooms, 50), { cx: 0.5, cy: 0.5, zoom: 1 });
  // Held: cx clamps to 0.75 so a 2x zoom never shows past the right edge.
  assert.deepEqual(zoomAt(zooms, 150), { cx: 0.75, cy: 0.5, zoom: 2 });
  const mid = zoomAt(zooms, 110);
  assert.ok(mid.zoom > 1 && mid.zoom < 2, `half-way zoom, got ${mid.zoom}`);
  assert.deepEqual(zoomAt(zooms, 230), { cx: 0.5, cy: 0.5, zoom: 1 });
});

test('back-to-back zooms pan directly instead of zooming out in between', () => {
  const zooms = [
    { start: 0, end: 60, cx: 0.3, cy: 0.3, zoom: 2, ramp: 15 },
    { start: 65, end: 120, cx: 0.7, cy: 0.7, zoom: 2, ramp: 15 },
  ];
  assert.equal(zoomAt(zooms, 62).zoom, 2);
  assert.equal(zoomAt(zooms, 70).zoom, 2);
});

test('zoom regions are anchored to the source, so a split keeps them', () => {
  const { doc, assetId } = project();
  const a = doc.insertClip({ kind: 'video', assetId, startFrame: 0, durationFrames: 120 });
  doc.updateClip(a.id, { zooms: [{ start: 60, end: 90, cx: 0.5, cy: 0.5, zoom: 2 }] });
  const [, right] = doc.splitClip(a.id, 50);
  assert.equal(right.kind !== 'component' && right.zooms?.length, 1);
});
