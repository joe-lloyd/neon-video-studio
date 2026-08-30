import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { ProjectDoc, ORIGIN_LOCAL, createUndoManager } from '../src/doc.ts';
import type { Asset } from '../src/types.ts';

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
