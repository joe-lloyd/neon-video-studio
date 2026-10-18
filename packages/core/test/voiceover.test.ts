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
    { line: 'line-one', start: 90, duration: 60, trim: 15, asset: 'b'.repeat(64), volume: 1 },
    { line: 'line-two', start: 180, duration: 90, trim: 180, asset: 'a'.repeat(64), volume: 1 },
  ]);
  undo.undo();
  assert.equal(takes(doc).find(c => c.line === 'line-one')!.asset, 'a'.repeat(64));
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
