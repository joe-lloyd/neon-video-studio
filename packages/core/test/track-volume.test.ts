import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectDoc, createUndoManager, ORIGIN_LOCAL } from '../src/doc.ts';
import { ProjectSchema, UpdateTrackRequestSchema } from '../src/schemas.ts';

test('track volume persists and undoes independently from individual clip gains', () => {
  const doc = new ProjectDoc(); doc.ensureInitialized({ fps: 30 });
  const track = doc.addTrack('audio', 'VO');
  doc.addAsset({ id: 'a'.repeat(64), kind: 'audio', name: 'take.wav', mime: 'audio/wav', size: 9000, durationFrames: 300, importedAt: '' });
  const clip = doc.insertClip({ kind: 'audio', trackId: track.id, assetId: 'a'.repeat(64), volume: 0.7 });
  const undo = createUndoManager(doc);
  doc.updateTrack(track.id, { volume: 1.5 }, ORIGIN_LOCAL);
  assert.equal(doc.getTrack(track.id)!.volume, 1.5);
  assert.deepEqual(doc.getClip(clip.id), clip);
  assert.equal(ProjectSchema.parse(doc.toJSON()).tracks.find(t => t.id === track.id)!.volume, 1.5);
  undo.undo();
  assert.equal(doc.getTrack(track.id)!.volume, 1);
  undo.redo();
  assert.equal(doc.getTrack(track.id)!.volume, 1.5);
});

test('old projects without track gain remain valid and invalid gains cannot enter the document', () => {
  const doc = new ProjectDoc(); doc.ensureInitialized({ fps: 30 });
  const project = doc.toJSON();
  for (const track of project.tracks) delete track.volume;
  assert.equal(ProjectSchema.safeParse(project).success, true);
  const track = doc.toJSON().tracks[0]!;
  for (const volume of [-1, 3, Infinity, NaN]) {
    assert.throws(() => doc.updateTrack(track.id, { volume }), /Track volume/);
    assert.equal(UpdateTrackRequestSchema.safeParse({ id: track.id, patch: { volume } }).success, false);
  }
});
