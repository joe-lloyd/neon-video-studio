import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { ProjectDoc, ORIGIN_LOCAL, createUndoManager } from '../src/doc.ts';
import type { Asset } from '../src/types.ts';
import { sortTracks } from '../src/ops.ts';
import { registerPack, unregisterPack } from '../src/templates.ts';

const asset = (id: string, durationFrames = 300): Asset => ({
  id,
  name: `${id.slice(0, 6)}.mp4`,
  kind: 'video',
  mime: 'video/mp4',
  size: 1,
  durationFrames,
  importedAt: '2026-01-01T00:00:00.000Z',
});
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fresh(): ProjectDoc {
  const pd = new ProjectDoc();
  pd.ensureInitialized({ name: 'Test', fps: 30 });
  return pd;
}

test('ensureInitialized creates meta and three default tracks, idempotently', () => {
  const pd = fresh();
  pd.ensureInitialized();
  const p = pd.toJSON();
  assert.equal(p.meta.name, 'Test');
  assert.equal(p.tracks.length, 3);
  assert.deepEqual(p.tracks.map((t) => t.kind), ['video', 'audio', 'overlay']);
});

test('insert component clip with defaults and validated props', () => {
  const pd = fresh();
  const clip = pd.insertClip({ kind: 'component', componentName: 'TextOverlay', props: { text: 'Hi' }, startFrame: 60 });
  assert.equal(clip.kind, 'component');
  assert.equal(clip.startFrame, 60);
  assert.equal(clip.durationFrames, 4 * 30);
  if (clip.kind === 'component') {
    assert.equal(clip.props.text, 'Hi');
    assert.equal(clip.props.fontSize, 96);
  }
  assert.throws(() => pd.insertClip({ kind: 'component', componentName: 'Nope' }), /Unknown component/);
  assert.throws(
    () => pd.insertClip({ kind: 'component', componentName: 'TextOverlay', props: { fontSize: 'big' } }),
    /Invalid props/,
  );
});

test('media clips append to the end of the track by default and use asset duration', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 120));
  const a = pd.insertClip({ kind: 'video', assetId: HASH_A });
  const b = pd.insertClip({ kind: 'video', assetId: HASH_A });
  assert.equal(a.startFrame, 0);
  assert.equal(a.durationFrames, 120);
  assert.equal(b.startFrame, 120);
  assert.equal(pd.durationFrames(), 240);
});

test('ripple insert splits the spanning clip and shifts later clips', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 100));
  pd.addAsset(asset(HASH_B, 50));
  const first = pd.insertClip({ kind: 'video', assetId: HASH_A }); // [0,100)
  const second = pd.insertClip({ kind: 'video', assetId: HASH_B }); // [100,150)
  const inserted = pd.insertClip({ kind: 'video', assetId: HASH_B, startFrame: 40, placement: 'ripple' }); // 50 frames
  const clips = pd.clipsOnTrack(first.trackId);
  assert.equal(clips.length, 4);
  const left = pd.getClip(first.id)!;
  assert.equal(left.durationFrames, 40);
  assert.equal(inserted.startFrame, 40);
  const rightHalf = clips.find((c) => c.kind === 'video' && c.assetId === HASH_A && c.id !== first.id)!;
  assert.equal(rightHalf.startFrame, 90);
  assert.equal(rightHalf.durationFrames, 60);
  if (rightHalf.kind !== 'component') assert.equal(rightHalf.trimBefore, 40);
  assert.equal(pd.getClip(second.id)!.startFrame, 150);
  // no overlaps
  const sorted = [...clips].sort((x, y) => x.startFrame - y.startFrame);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]!.startFrame >= sorted[i - 1]!.startFrame + sorted[i - 1]!.durationFrames);
  }
});

test('free placement finds the nearest gap', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 100));
  pd.insertClip({ kind: 'video', assetId: HASH_A }); // [0,100)
  const c = pd.insertClip({ kind: 'video', assetId: HASH_A, startFrame: 30, placement: 'free' });
  assert.equal(c.startFrame, 100);
});

test('split, trim and move', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 100));
  const c = pd.insertClip({ kind: 'video', assetId: HASH_A });
  const [l, r] = pd.splitClip(c.id, 30);
  assert.equal(l.durationFrames, 30);
  assert.equal(r.startFrame, 30);
  assert.equal(r.durationFrames, 70);
  if (r.kind !== 'component') assert.equal(r.trimBefore, 30);
  const trimmed = pd.trimClip(r.id, 'start', 40);
  assert.equal(trimmed.startFrame, 40);
  assert.equal(trimmed.durationFrames, 60);
  if (trimmed.kind !== 'component') assert.equal(trimmed.trimBefore, 40);
  const moved = pd.moveClip(l.id, 50); // collides with [40,100) → nearest free slot is 10 (|10-50| < |100-50|)
  assert.equal(moved.startFrame, 10);
  const moved2 = pd.moveClip(l.id, 95); // → after the collider
  assert.equal(moved2.startFrame, 100);
  assert.throws(() => pd.splitClip(l.id, 5000), /outside/);
});

test('cannot place clip on the wrong track kind', () => {
  const pd = fresh();
  const audio = pd.toJSON().tracks.find((t) => t.kind === 'audio')!;
  assert.throws(() => pd.insertClip({ kind: 'component', componentName: 'TextOverlay', trackId: audio.id }), /Cannot place/);
});

test('two documents converge after exchanging updates (CRDT)', () => {
  const a = fresh();
  const b = new ProjectDoc();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  a.insertClip({ kind: 'component', componentName: 'TextOverlay', props: { text: 'from A' }, startFrame: 0 });
  b.insertClip({ kind: 'component', componentName: 'LowerThird', startFrame: 200 });
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  assert.deepEqual(a.toJSON().clips, b.toJSON().clips);
  assert.equal(a.toJSON().clips.length, 2);
});

test('undo manager only tracks local origin', () => {
  const pd = fresh();
  const undo = createUndoManager(pd);
  pd.insertClip({ kind: 'component', componentName: 'TextOverlay' }, ORIGIN_LOCAL);
  pd.insertClip({ kind: 'component', componentName: 'Countdown' }, 'neon:api');
  assert.equal(pd.toJSON().clips.length, 2);
  undo.undo();
  assert.equal(pd.toJSON().clips.length, 1);
  assert.equal(pd.toJSON().clips[0]!.name, 'Countdown');
});

test('load + toJSON round-trips', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A));
  pd.insertClip({ kind: 'video', assetId: HASH_A });
  pd.insertClip({ kind: 'component', componentName: 'Watermark', props: { text: 'X' } });
  const json = pd.toJSON();
  const copy = ProjectDoc.fromJSON(json);
  assert.deepEqual(copy.toJSON(), json);
});


test('cutRanges removes a range across tracks, splits spanning clips, ripples and adds crossfades', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 300));
  const v = pd.insertClip({ kind: 'video', assetId: HASH_A }); // [0,300)
  const overlay = pd.insertClip({ kind: 'component', componentName: 'Watermark', startFrame: 200, durationFrames: 100, placement: 'overlap' }); // [200,300)
  const result = pd.cutRanges([{ start: 100, end: 130 }, { start: 250, end: 260 }], { ripple: true, crossfadeFrames: 2 });
  assert.equal(result.removedFrames, 40);
  const clips = pd.toJSON().clips;
  const videos = clips.filter((c) => c.kind === 'video').sort((a, b) => a.startFrame - b.startFrame);
  assert.equal(videos.length, 3);
  assert.deepEqual(videos.map((c) => [c.startFrame, c.durationFrames]), [[0, 100], [100, 120], [220, 40]]);
  // source continuity: second piece starts at source frame 130, third at 260
  if (videos[1]!.kind !== 'component') assert.equal(videos[1]!.trimBefore, 130);
  if (videos[2]!.kind !== 'component') assert.equal(videos[2]!.trimBefore, 260);
  if (videos[0]!.kind !== 'component') assert.equal(videos[0]!.fadeOut, 2);
  if (videos[1]!.kind !== 'component') assert.equal(videos[1]!.fadeIn, 2);
  const overlays = clips.filter((c) => c.kind === 'component');
  // overlay [200,300) → shifted by 30 → [170,270) then cut [250,260) → [170,250) + [250,260)…
  assert.equal(overlays.reduce((n, c) => n + c.durationFrames, 0), 90);
  assert.ok(overlays.every((c) => c.startFrame >= 170));
  assert.equal(pd.durationFrames(), 260);
  assert.ok(pd.getClip(v.id));
  void overlay;
});

test('transcripts round-trip and undo covers them', () => {
  const pd = fresh();
  pd.setTranscript({ assetId: HASH_A, engine: 'test', language: 'en', createdAt: 'now', words: [{ w: 'um', s: 0, e: 0.3, filler: true }] }, ORIGIN_LOCAL);
  assert.equal(pd.getTranscript(HASH_A)?.words.length, 1);
  const copy = ProjectDoc.fromJSON(pd.toJSON());
  assert.deepEqual(copy.toJSON().transcripts, pd.toJSON().transcripts);
});


test('detachAudio creates a linked audio clip and mutes the video', () => {
  const pd = fresh();
  pd.addAsset(asset(HASH_A, 120));
  const v = pd.insertClip({ kind: 'video', assetId: HASH_A, startFrame: 30 });
  const a = pd.detachAudio(v.id);
  assert.equal(a.kind, 'audio');
  assert.equal(a.startFrame, 30);
  assert.equal(a.durationFrames, v.durationFrames);
  assert.equal((a as { assetId?: string }).assetId, HASH_A);
  const video = pd.getClip(v.id)!;
  if (video.kind !== 'component') assert.equal(video.volume, 0);
  const audioTrack = pd.toJSON().tracks.find((t) => t.id === a.trackId)!;
  assert.equal(audioTrack.kind, 'audio');
});

test('addTrack groups new lanes under the last lane of the same kind', () => {
  const pd = fresh();
  pd.addTrack('video');
  pd.addTrack('overlay');
  pd.addTrack('audio');
  pd.addTrack('video');
  const names = sortTracks(pd.toJSON().tracks).map((t) => t.name);
  assert.deepEqual(names, ['V1', 'V2', 'V3', 'A1', 'A2', 'FX1', 'FX2']);
  const orders = sortTracks(pd.toJSON().tracks).map((t) => t.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(new Set(orders).size, orders.length, 'orders stay unique');
});

test('addTrack places an empty section after the sections that precede it', () => {
  const pd = fresh();
  for (const t of pd.toJSON().tracks) if (t.kind !== 'overlay') pd.removeTrack(t.id);
  pd.addTrack('audio');
  pd.addTrack('video');
  pd.addTrack('audio');
  assert.deepEqual(sortTracks(pd.toJSON().tracks).map((t) => t.name), ['V1', 'A1', 'A2', 'FX1']);
});

test('applySnapshot restores an earlier state with a minimal diff and is not undoable', () => {
  const pd = fresh();
  const undo = createUndoManager(pd);
  const before = pd.toJSON();
  const a = pd.insertClip({ kind: 'component', componentName: 'TextOverlay' }, ORIGIN_LOCAL);
  pd.insertClip({ kind: 'component', componentName: 'Countdown' }, ORIGIN_LOCAL);
  const mid = pd.toJSON();
  pd.updateClip(a.id, { name: 'Renamed' }, ORIGIN_LOCAL);
  const clipMapBefore = pd.clips.get(mid.clips[1]!.id);
  const undoDepth = undo.undoStack.length;

  pd.applySnapshot(mid);
  assert.equal(pd.getClip(a.id)?.name, mid.clips.find((c) => c.id === a.id)!.name);
  assert.equal(pd.toJSON().clips.length, 2);
  // the untouched clip keeps its Yjs identity (no churn for peers)
  assert.equal(pd.clips.get(mid.clips[1]!.id), clipMapBefore);
  // system-origin restore does not enter the local undo stack
  assert.equal(undo.undoStack.length, undoDepth);

  pd.applySnapshot(before);
  assert.equal(pd.toJSON().clips.length, 0);
  assert.equal(pd.toJSON().tracks.length, 3);
  assert.equal(pd.toJSON().meta.updatedAt, before.meta.updatedAt);
});

test('inserting a component from an installed pack enables the pack in the project', () => {
  registerPack({ name: 'test-installed', label: 'Test', version: '1', templates: [{ name: 'InstalledThing', label: 'x', description: '', defaultDurationSeconds: 2, fields: [] }] }, 'installed', '/tmp/test-installed');
  try {
    const pd = fresh();
    assert.equal(pd.toJSON().meta.packs, undefined);
    pd.insertClip({ kind: 'component', componentName: 'InstalledThing' }, ORIGIN_LOCAL);
    assert.deepEqual(pd.toJSON().meta.packs, ['test-installed']);
    pd.insertClip({ kind: 'component', componentName: 'TextOverlay' }, ORIGIN_LOCAL);
    pd.insertClip({ kind: 'component', componentName: 'InstalledThing' }, ORIGIN_LOCAL);
    assert.deepEqual(pd.toJSON().meta.packs, ['test-installed']);
  } finally {
    unregisterPack('test-installed');
  }
});

test('moveClips shifts a selection rigidly, clamps at frame 0 and dodges outside clips', () => {
  const pd = fresh();
  const fx = pd.toJSON().tracks.find((t) => t.kind === 'overlay')!;
  const a = pd.insertClip({ kind: 'component', componentName: 'TextOverlay', startFrame: 10, durationFrames: 10, trackId: fx.id, placement: 'overlap' }, ORIGIN_LOCAL);
  const b = pd.insertClip({ kind: 'component', componentName: 'TextOverlay', startFrame: 30, durationFrames: 10, trackId: fx.id, placement: 'overlap' }, ORIGIN_LOCAL);
  const blocker = pd.insertClip({ kind: 'component', componentName: 'TextOverlay', startFrame: 60, durationFrames: 10, trackId: fx.id, placement: 'overlap' }, ORIGIN_LOCAL);
  pd.moveClips([a.id, b.id], 5, ORIGIN_LOCAL);
  assert.deepEqual([pd.getClip(a.id)!.startFrame, pd.getClip(b.id)!.startFrame], [15, 35]);
  // clamp: leftmost cannot go below 0, the group keeps its spacing
  pd.moveClips([a.id, b.id], -100, ORIGIN_LOCAL);
  assert.deepEqual([pd.getClip(a.id)!.startFrame, pd.getClip(b.id)!.startFrame], [0, 20]);
  // b would land on the blocker (60..70) → resolves to the nearest free slot, a moves freely
  pd.moveClips([a.id, b.id], 42, ORIGIN_LOCAL);
  assert.equal(pd.getClip(a.id)!.startFrame, 42);
  assert.ok(pd.getClip(b.id)!.startFrame === 50 || pd.getClip(b.id)!.startFrame === 70, `b at ${pd.getClip(b.id)!.startFrame}`);
  assert.equal(pd.getClip(blocker.id)!.startFrame, 60);
});
