import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignWordsToSpeech } from '../src/align.ts';
import { wordsFromWhisperJson } from '../src/transcribe.ts';
import { DEFAULT_FILLERS, fillerRanges, markFillers } from '../src/fillers.ts';

// Real numbers from a narrated take: whisper put "um" at 0.36–0.72 s, DTW anchored it at 0.80 s,
// and the audio has pauses at 0.456–0.663 s and 0.959–1.192 s — the spoken "um" is 0.663–0.959 s.
const whisper = {
  transcription: [
    {
      text: ' So, um, today',
      offsets: { from: 130, to: 940 },
      tokens: [
        { text: ' So', offsets: { from: 130, to: 180 }, p: 0.9, t_dtw: 26 },
        { text: ',', offsets: { from: 180, to: 360 }, p: 0.9, t_dtw: 30 },
        { text: ' um', offsets: { from: 360, to: 440 }, p: 0.6, t_dtw: 80 },
        { text: ',', offsets: { from: 440, to: 720 }, p: 0.9, t_dtw: 85 },
        { text: ' today', offsets: { from: 720, to: 940 }, p: 0.9, t_dtw: 130 },
      ],
    },
  ],
};
const pauses = [
  { start: 0.456, end: 0.663 },
  { start: 0.959, end: 1.192 },
];

test('DTW anchors + real pauses put each word on its actual audio', () => {
  const words = alignWordsToSpeech(wordsFromWhisperJson(whisper), pauses, 2);
  assert.deepEqual(
    words.map((w) => [w.w, w.s, w.e]),
    [
      ['So,', 0.13, 0.456],
      ['um,', 0.663, 0.959],
      ['today', 1.192, 1.8],
    ],
  );
});

test('a filler cut covers the spoken filler, not the word before it', () => {
  const words = alignWordsToSpeech(wordsFromWhisperJson(whisper), pauses, 2);
  markFillers(words, DEFAULT_FILLERS);
  const [cut] = fillerRanges(words, 40);
  assert.ok(cut && cut.start <= 0.663 && cut.end >= 0.959, `cut ${JSON.stringify(cut)} covers 0.663–0.959`);
  assert.ok(cut.start >= 0.456, 'never eats into "So"');
});

test('without DTW anchors the whisper timing is kept as-is', () => {
  const plain = { transcription: [{ ...whisper.transcription[0]!, tokens: whisper.transcription[0]!.tokens.map(({ t_dtw: _drop, ...t }) => t) }] };
  const before = wordsFromWhisperJson(plain).map((w) => [w.s, w.e]);
  const after = alignWordsToSpeech(wordsFromWhisperJson(plain), pauses, 2).map((w) => [w.s, w.e]);
  assert.deepEqual(after, before);
});

test('continuous speech splits between anchors at the midpoint', () => {
  const words = alignWordsToSpeech(
    [
      { w: 'so', s: 0, e: 0.2, t: 0.1 },
      { w: 'um', s: 0.2, e: 0.4, t: 0.5 },
    ],
    [],
    1,
  );
  assert.deepEqual(words.map((w) => [w.s, w.e]), [[0, 0.3], [0.3, 1]]);
});
