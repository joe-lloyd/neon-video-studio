import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDoc, captionPages, timelineWords, toSrt, toVtt, type MediaClip, type TimelineWord } from '../src/index.ts';

const TAKE = 'a'.repeat(64);
const DENOISED = 'b'.repeat(64);

/** 30 fps project with one 20 s take whose transcript says "Hello um world. This is a test." */
function project(): ProjectDoc {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ name: 't', fps: 30, width: 1920, height: 1080 });
  doc.addAsset({ id: TAKE, name: 'take.mp4', kind: 'video', mime: 'video/mp4', size: 1, durationFrames: 600, importedAt: '2026-01-01T00:00:00Z' });
  doc.setTranscript({
    assetId: TAKE,
    engine: 'test',
    language: 'en',
    createdAt: '2026-01-01T00:00:00Z',
    words: [
      { w: ' Hello', s: 0, e: 0.5 }, // frames 0–15
      { w: ' um', s: 0.6, e: 0.9, filler: true }, // 18–27
      { w: ' world.', s: 1, e: 1.5 }, // 30–45
      { w: ' This', s: 2, e: 2.3 }, // 60–69
      { w: ' is', s: 2.3, e: 2.5 }, // 69–75
      { w: ' a', s: 2.5, e: 2.6 }, // 75–78
      { w: ' test.', s: 2.6, e: 3 }, // 78–90
    ],
  });
  return doc;
}

const row = (w: TimelineWord) => `${w.text} ${w.start}-${w.end}`;

test('words land on the timeline at their source time, fillers dropped', () => {
  const doc = project();
  doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 0, durationFrames: 120 });
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15', 'world. 30-45', 'This 60-69', 'is 69-75', 'a 75-78', 'test. 78-90']);
  assert.deepEqual(timelineWords(doc.toJSON(), { keepFillers: true }).map(row).slice(0, 3), ['Hello 0-15', 'um 18-27', 'world. 30-45']);
});

test('trimmed and moved clips shift their words', () => {
  const doc = project();
  doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 100, durationFrames: 40, trimBefore: 60 });
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['This 100-109', 'is 109-115', 'a 115-118', 'test. 118-130']);
});

test('a ripple cut removes the words it covers and pulls later words left', () => {
  const doc = project();
  doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 0, durationFrames: 120 });
  doc.cutRanges([{ start: 15, end: 30 }, { start: 69, end: 75 }]);
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15', 'world. 15-30', 'This 45-54', 'a 54-57', 'test. 57-69']);
});

test('a sped-up range compresses its words; above 2x the words go silent', () => {
  const doc = project();
  const clip = doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 0, durationFrames: 120 });
  doc.setClipSpeed(clip.id, 2, { start: 60, end: 90 });
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15', 'world. 30-45', 'This 60-65', 'is 65-68', 'a 68-69', 'test. 69-75']);

  const fast = doc.toJSON().clips.find((c): c is MediaClip => c.kind === 'video' && c.speed === 2)!;
  doc.setClipSpeed(fast.id, 4);
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15', 'world. 30-45']);
});

test('a clip of a derived (denoised) asset uses the original transcript', () => {
  const doc = project();
  doc.addAsset({ id: DENOISED, name: 'take.denoised.wav', kind: 'audio', mime: 'audio/wav', size: 1, derivedFrom: TAKE, importedAt: '2026-01-01T00:00:00Z' });
  doc.insertClip({ kind: 'audio', assetId: DENOISED, startFrame: 30, durationFrames: 30, trimBefore: 30 });
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['world. 30-45']);
});

test('after detaching audio the words come from the audio clip; muted words vanish', () => {
  const doc = project();
  const clip = doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 0, durationFrames: 50 });
  const audio = doc.detachAudio(clip.id);
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15', 'world. 30-45']);
  // "Mute words" zeroes the gain over a word in place: it is no longer heard, so no caption.
  doc.updateClip(audio.id, { volumeKeyframes: [{ frame: 28, gain: 1 }, { frame: 29, gain: 0 }, { frame: 46, gain: 0 }, { frame: 47, gain: 1 }] });
  assert.deepEqual(timelineWords(doc.toJSON()).map(row), ['Hello 0-15']);
});

test('the track filter picks clips by track name', () => {
  const doc = project();
  doc.insertClip({ kind: 'video', assetId: TAKE, startFrame: 0, durationFrames: 50 });
  assert.deepEqual(timelineWords(doc.toJSON(), { tracks: ['v1'] }).map(row), ['Hello 0-15', 'world. 30-45']);
  assert.deepEqual(timelineWords(doc.toJSON(), { tracks: ['A1'] }), []);
});

test('an empty project has no words and no cues', () => {
  const doc = project();
  assert.deepEqual(captionPages(timelineWords(doc.toJSON()), { maxGapFrames: 18 }), []);
  assert.equal(toSrt([], 30), '');
  assert.equal(toVtt([], 30), 'WEBVTT\n\n');
});

const w = (text: string, start: number, end: number): TimelineWord => ({ text, start, end });

test('cues break on sentences, long pauses and length, and linger briefly', () => {
  const words = [
    w('Hello', 0, 10), w('world.', 10, 20), // sentence end
    w('Click', 22, 30), w('the', 30, 33), w('green', 33, 40), w('button', 40, 50), // length (maxWords 4)
    w('now', 50, 60), // pause of 40 frames follows
    w('Done', 100, 110),
  ];
  const cues = captionPages(words, { maxWords: 4, maxGapFrames: 15 });
  assert.deepEqual(cues.map((c) => [c.text, c.start, c.end]), [
    ['Hello world.', 0, 22],
    ['Click the green button', 22, 50],
    ['now', 50, 75],
    ['Done', 100, 125],
  ]);
});

test('a clause break waits until the cue is half full; maxChars caps the line', () => {
  const words = [w('So,', 0, 5), w('first', 5, 10), w('we', 10, 15), w('open,', 15, 20), w('the', 20, 25), w('settings', 25, 30)];
  assert.deepEqual(captionPages(words, { maxWords: 6, maxGapFrames: 10 }).map((c) => c.text), ['So, first we open,', 'the settings']);
  assert.deepEqual(captionPages(words, { maxWords: 10, maxChars: 12, maxGapFrames: 10 }).map((c) => c.text), ['So, first we', 'open, the', 'settings']);
});

test('SRT and WebVTT serialise cues in clock time', () => {
  const cues = captionPages([w('Hello', 0, 15), w('world.', 15, 45), w('Next', 3600 * 30, 3600 * 30 + 15)], { maxGapFrames: 15 });
  assert.equal(
    toSrt(cues, 30),
    '1\n00:00:00,000 --> 00:00:02,000\nHello world.\n\n2\n01:00:00,000 --> 01:00:01,000\nNext\n',
  );
  assert.equal(
    toVtt(cues, 30),
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world.\n\n01:00:00.000 --> 01:00:01.000\nNext\n',
  );
});
