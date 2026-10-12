import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDoc } from '../src/doc.ts';
import { ProjectSchema } from '../src/schemas.ts';
import { cueStateAt, speakingSeconds, cueIsTight } from '../src/script.ts';

const fresh = () => {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ name: 'script test' });
  return doc;
};
const texts = (doc: ProjectDoc) => doc.toJSON().cues.map((c) => [c.startFrame, c.durationFrames, c.text]);

test('cues are stored in timeline order and edited by id', () => {
  const doc = fresh();
  doc.setCues([
    { startFrame: 300, durationFrames: 90, text: 'Second line.' },
    { startFrame: 0, durationFrames: 120, text: 'First line.' },
  ]);
  assert.deepEqual(texts(doc), [[0, 120, 'First line.'], [300, 90, 'Second line.']]);
  const [first] = doc.toJSON().cues;
  doc.updateCue(first!.id, { text: 'First line, tweaked.' });
  assert.equal(doc.toJSON().cues[0]!.text, 'First line, tweaked.');
  doc.removeCues([first!.id]);
  assert.deepEqual(texts(doc), [[300, 90, 'Second line.']]);
});

test('a ripple cut across the timeline removes, trims and shifts cues', () => {
  const doc = fresh();
  doc.setCues([
    { startFrame: 0, durationFrames: 100, text: 'before' },
    { startFrame: 100, durationFrames: 100, text: 'overlaps the cut start' },
    { startFrame: 210, durationFrames: 30, text: 'inside' },
    { startFrame: 260, durationFrames: 100, text: 'overlaps the cut end' },
    { startFrame: 400, durationFrames: 50, text: 'after' },
  ]);
  doc.cutRanges([{ start: 150, end: 300 }]);
  assert.deepEqual(texts(doc), [
    [0, 100, 'before'],
    [100, 50, 'overlaps the cut start'],
    [150, 60, 'overlaps the cut end'],
    [250, 50, 'after'],
  ]);
});

test('a cut limited to some tracks leaves the script alone', () => {
  const doc = fresh();
  doc.setCues([{ startFrame: 400, durationFrames: 50, text: 'after' }]);
  const v1 = doc.toJSON().tracks[0]!.id;
  doc.cutRanges([{ start: 150, end: 300 }], { trackIds: [v1] });
  assert.deepEqual(texts(doc), [[400, 50, 'after']]);
});

test('projects saved before cues existed load with an empty script', () => {
  const json = fresh().toJSON() as unknown as Record<string, unknown>;
  delete json.cues;
  assert.deepEqual(ProjectSchema.parse(json).cues, []);
});

test('cueStateAt finds the line being said and the one coming up', () => {
  const cues = [
    { id: 'a', startFrame: 30, durationFrames: 60, text: 'a' },
    { id: 'b', startFrame: 120, durationFrames: 60, text: 'b' },
  ];
  assert.deepEqual(cueStateAt(cues, 0), { current: -1, next: 0, framesToNext: 30 });
  assert.deepEqual(cueStateAt(cues, 45), { current: 0, next: 1, framesToNext: 75 });
  assert.deepEqual(cueStateAt(cues, 100), { current: -1, next: 1, framesToNext: 20 });
  assert.deepEqual(cueStateAt(cues, 500), { current: -1, next: -1, framesToNext: null });
});

test('a line is tight when it takes longer to say than its slot', () => {
  assert.equal(speakingSeconds('one two three four five six'), 2);
  assert.equal(cueIsTight({ id: 'x', startFrame: 0, durationFrames: 45, text: 'one two three four five six' }, 30), true);
  assert.equal(cueIsTight({ id: 'x', startFrame: 0, durationFrames: 75, text: 'one two three four five six' }, 30), false);
});
