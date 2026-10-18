import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDoc, createUndoManager, ORIGIN_LOCAL } from '../src/doc.ts';
import { ProjectSchema } from '../src/schemas.ts';

function setup() {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ fps: 30 });
  doc.addAsset({ id: 'a'.repeat(64), name: 'original.wav', kind: 'audio', mime: 'audio/wav', size: 9000, durationFrames: 600, importedAt: '' });
  doc.addAsset({ id: 'b'.repeat(64), name: 'new.wav', kind: 'audio', mime: 'audio/wav', size: 9000, durationFrames: 120, importedAt: '' });
  doc.setScript([{ title: 'Intro', lines: [
    { id: 'line-one', say: 'Hello there.', placed: { startFrame: 90, durationFrames: 60 } },
    { id: 'line-two', say: 'This is the second line.', placed: { startFrame: 180, durationFrames: 90 } },
  ] }]);
  return doc;
}

const takes = (doc: ProjectDoc) => doc.toJSON().clips.flatMap(c => c.kind === 'audio' ? [{ line: c.scriptLineId, start: c.startFrame, duration: c.durationFrames, trim: c.trimBefore, asset: c.assetId, volume: c.volume }] : []);

test('continuous voice-over becomes source-preserving clips for each script line, without rippling the script', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  assert.deepEqual(takes(doc), [
    { line: 'line-one', start: 90, duration: 60, trim: 90, asset: 'a'.repeat(64), volume: 1 },
    { line: 'line-two', start: 180, duration: 90, trim: 180, asset: 'a'.repeat(64), volume: 1 },
  ]);
  assert.deepEqual(doc.getScript().sections[0]!.lines.map(l => l.placed), [{ startFrame: 90, durationFrames: 60 }, { startFrame: 180, durationFrames: 90 }]);
  assert.equal(ProjectSchema.safeParse(doc.toJSON()).success, true);
});

test('a re-recording replaces only its own line after successful import and preserves the other take', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  const undo = createUndoManager(doc);
  doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 90, lineId: 'line-one', trimBefore: 15 }, ORIGIN_LOCAL);
  assert.deepEqual(takes(doc).sort((a,b) => a.start-b.start), [
    { line: 'line-one', start: 90, duration: 105, trim: 15, asset: 'b'.repeat(64), volume: 1 },
    { line: 'line-two', start: 180, duration: 90, trim: 180, asset: 'a'.repeat(64), volume: 1 },
  ]);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 90, durationFrames: 105 });
  undo.undo();
  assert.equal(takes(doc).find(c => c.line === 'line-one')!.asset, 'a'.repeat(64));
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 90, durationFrames: 60 });
});

test('a missing or empty new take never removes the previous recording', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  const before = takes(doc);
  assert.throws(() => doc.placeVoiceOver({ assetId: 'missing', startFrame: 90, lineId: 'line-one' }), /asset/i);
  assert.throws(() => doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 90, lineId: 'line-one', trimBefore: 120 }), /empty|audio/i);
  assert.deepEqual(takes(doc), before);
});

test('an existing take can be split into named lines without changing its source, volume or timeline positions', () => {
  const doc = setup();
  const track = doc.addTrack('audio', 'VO');
  const old = doc.insertClip({ kind: 'audio', assetId: 'a'.repeat(64), trackId: track.id, startFrame: 30, durationFrames: 300, trimBefore: 15, volume: .8 });
  const clips = doc.splitVoiceOver(old.id);
  assert.equal(clips.length, 2);
  assert.deepEqual(takes(doc), [
    { line: 'line-one', start: 90, duration: 60, trim: 75, asset: 'a'.repeat(64), volume: .8 },
    { line: 'line-two', start: 180, duration: 90, trim: 165, asset: 'a'.repeat(64), volume: .8 },
  ]);
  assert.equal(doc.toJSON().assets.length, 2);
});

test('voice detection trims only the ends of a line, preserving pauses within it and the video clock', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300, speechRanges: [{ start: 100, end: 115 }, { start: 130, end: 140 }, { start: 200, end: 250 }] });
  assert.deepEqual(takes(doc), [
    { line: 'line-one', start: 100, duration: 40, trim: 100, asset: 'a'.repeat(64), volume: 1 },
    { line: 'line-two', start: 200, duration: 50, trim: 200, asset: 'a'.repeat(64), volume: 1 },
  ]);
});

test('a silent re-recording keeps the previous take and locked tracks cannot be replaced', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  const before = takes(doc);
  assert.throws(() => doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 90, lineId: 'line-one', speechRanges: [] }), /No speech/);
  const track = doc.toJSON().tracks.find(t => t.name === 'VO')!;
  doc.updateTrack(track.id, { locked: true });
  assert.throws(() => doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 90, lineId: 'line-one' }), /locked/);
  assert.deepEqual(takes(doc), before);
});

test('moving a linked voice-over updates its script cue and undo restores both together', () => {
  const doc = setup();
  const [clip] = doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300, speechRanges: [{ start: 100, end: 140 }, { start: 200, end: 250 }] });
  const undo = createUndoManager(doc);
  doc.moveClip(clip!.id, 300, undefined, ORIGIN_LOCAL);
  assert.deepEqual(doc.getScript().sections[0]!.lines.map(l => l.placed), [
    { startFrame: 300, durationFrames: 40 }, { startFrame: 180, durationFrames: 90 },
  ]);
  assert.equal(doc.getClip(clip!.id)?.startFrame, 300);
  undo.undo();
  assert.equal(doc.getClip(clip!.id)?.startFrame, 100);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 90, durationFrames: 60 });
  undo.redo();
  assert.equal(doc.getClip(clip!.id)?.startFrame, 300);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 300, durationFrames: 40 });
});

test('moving one piece of a split line uses all its pieces without moving the other audio', () => {
  const doc = setup();
  const [clip] = doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  const [left, right] = doc.splitClip(clip!.id, 120);
  doc.moveClip(left.id, 30);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 30, durationFrames: 120 });
  assert.equal(doc.getClip(right.id)?.startFrame, 120);
  const remaining = doc.getClip(right.id);
  assert.ok(remaining && remaining.kind === 'audio');
  assert.equal(remaining.trimBefore, 120);
});

test('group moves update every linked cue to the final clip positions and preserve gaps', () => {
  const doc = setup();
  const clips = doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  const [left, right] = doc.splitClip(clips[0]!.id, 120);
  doc.trimClip(left.id, 'end', 110);
  doc.moveClips([left.id, right.id, clips[1]!.id], 30);
  assert.deepEqual(doc.getScript().sections[0]!.lines.map(l => l.placed), [
    { startFrame: 120, durationFrames: 60 }, { startFrame: 210, durationFrames: 90 },
  ]);
  assert.deepEqual(doc.toJSON().clips.map(c => [c.startFrame, c.durationFrames]), [[120, 20], [150, 30], [210, 90]]);
});

test('script cues follow the resolved collision position and direct timing edits', () => {
  const doc = setup();
  const [clip] = doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  doc.moveClip(clip!.id, 240);
  assert.equal(doc.getClip(clip!.id)?.startFrame, 270);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 270, durationFrames: 60 });
  doc.updateClip(clip!.id, { startFrame: 320, durationFrames: 45 });
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 320, durationFrames: 45 });
});

test('trimming linked audio updates the cue and source offset, while unrelated edits leave cues alone', () => {
  const doc = setup();
  const [clip] = doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  doc.trimClip(clip!.id, 'start', 100);
  doc.trimClip(clip!.id, 'end', 140);
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 100, durationFrames: 40 });
  const media = doc.getClip(clip!.id);
  assert.ok(media && media.kind === 'audio');
  assert.equal(media.trimBefore, 100);
  doc.updateClip(clip!.id, { volume: .5 });
  const track = doc.toJSON().tracks.find(t => t.name === 'VO')!;
  const unrelated = doc.insertClip({ kind: 'audio', assetId: 'a'.repeat(64), trackId: track.id, startFrame: 400, durationFrames: 30, name: 'Hello there.', placement: 'overlap' });
  doc.moveClip(unrelated.id, 450);
  assert.deepEqual(doc.getScript().sections[0]!.lines.map(l => l.placed), [
    { startFrame: 100, durationFrames: 40 }, { startFrame: 180, durationFrames: 90 },
  ]);
});

test('a single-line take includes speech beyond the old end and updates the cue to the new length', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'a'.repeat(64), startFrame: 0, durationFrames: 300 });
  doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 90, lineId: 'line-one', trimBefore: 10,
    speechRanges: [{ start: 20, end: 40 }, { start: 85, end: 115 }] });
  assert.deepEqual(takes(doc).find(c => c.line === 'line-one'),
    { line: 'line-one', start: 100, duration: 95, trim: 20, asset: 'b'.repeat(64), volume: 1 });
  assert.deepEqual(doc.getScript().sections[0]!.lines[0]!.placed, { startFrame: 100, durationFrames: 95 });
  assert.deepEqual(takes(doc).find(c => c.line === 'line-two'),
    { line: 'line-two', start: 180, duration: 90, trim: 180, asset: 'a'.repeat(64), volume: 1 });
});

test('a shorter single-line take shrinks the cue instead of retaining the previous duration', () => {
  const doc = setup();
  doc.placeVoiceOver({ assetId: 'b'.repeat(64), startFrame: 180, lineId: 'line-two', durationFrames: 40 });
  assert.deepEqual(doc.getScript().sections[0]!.lines[1]!.placed, { startFrame: 180, durationFrames: 40 });
  assert.equal(takes(doc)[0]!.duration, 40);
});
