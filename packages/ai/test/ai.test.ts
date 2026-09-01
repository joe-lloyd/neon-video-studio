import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairTimestamps, wordsFromWhisperJson } from '../src/transcribe.ts';
import { DEFAULT_FILLERS, fillerRanges, markFillers } from '../src/fillers.ts';
import { planSilenceCuts } from '../src/silence.ts';
import { breathKeyframes } from '../src/breaths.ts';
import { energyVad, frameEnergies, type Pcm } from '../src/pcm.ts';
import { extractConcepts, matchAssetsHeuristic } from '../src/broll.ts';
import { parseAspect, reframeFromTrack, smoothTrack } from '../src/reframe.ts';

const tok = (text: string, from: number, to: number, p = 0.9) => ({ text, offsets: { from, to }, p });

test('whisper tokens merge into words with timestamps', () => {
  const words = wordsFromWhisperJson({
    transcription: [
      {
        text: ' Um, so today',
        offsets: { from: 0, to: 1200 },
        tokens: [tok('[_BEG_]', 0, 0), tok(' Um', 0, 250, 0.1), tok(',', 250, 290), tok(' so', 620, 770), tok(' to', 800, 950), tok('day', 950, 1200)],
      },
    ],
  });
  assert.deepEqual(words.map((w) => w.w), ['Um,', 'so', 'today']);
  assert.equal(words[0]!.s, 0);
  assert.equal(words[0]!.e, 0.29);
  assert.equal(words[2]!.s, 0.8);
  assert.equal(words[2]!.e, 1.2);
  assert.equal(words[0]!.p, 0.1);
});

test('filler detection handles singles, phrases and the "like" aside rule', () => {
  const words = [
    { w: 'Um,', s: 0, e: 0.3 },
    { w: 'so', s: 0.6, e: 0.8 },
    { w: 'you', s: 0.9, e: 1.0 },
    { w: 'know,', s: 1.0, e: 1.2 },
    { w: 'I', s: 1.3, e: 1.4 },
    { w: 'like', s: 1.5, e: 1.7 },
    { w: 'markets,', s: 1.8, e: 2.2 },
    { w: 'like,', s: 2.3, e: 2.5 },
    { w: 'a', s: 2.6, e: 2.7 },
    { w: 'lot.', s: 2.7, e: 3.0 },
  ];
  const flagged = markFillers(words, DEFAULT_FILLERS);
  assert.deepEqual(flagged, [0, 2, 3, 7]); // "I like markets" keeps its verb; ", like," is a filler
  const ranges = fillerRanges(words, 40);
  assert.equal(ranges.length, 3);
  assert.ok(ranges[0]!.start === 0 && ranges[0]!.end <= 0.6);
  assert.ok(ranges[1]!.start >= 0.8 && ranges[1]!.end <= 1.3);
});

test('silence planning keeps a natural pause', () => {
  const cuts = planSilenceCuts([{ start: 1, end: 2.2 }, { start: 5, end: 5.3 }], 400, 150);
  assert.equal(cuts.length, 1);
  assert.ok(Math.abs(cuts[0]!.start - 1.075) < 1e-9);
  assert.ok(Math.abs(cuts[0]!.end - 2.125) < 1e-9);
});

test('energy VAD separates tone from silence', () => {
  const sr = 16000;
  const samples = new Float32Array(sr * 3);
  for (let i = sr; i < sr * 2; i++) samples[i] = 0.3 * Math.sin((i * 2 * Math.PI * 440) / sr); // 1s tone in the middle
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) + (Math.random() - 0.5) * 0.002; // faint noise floor
  const pcm: Pcm = { samples, sampleRate: sr, durationSeconds: 3 };
  const vad = energyVad(frameEnergies(pcm, 20), { minSilenceMs: 100 });
  assert.equal(vad.speech.length, 1);
  assert.ok(Math.abs(vad.speech[0]!.start - 1) < 0.05 && Math.abs(vad.speech[0]!.end - 2) < 0.05);
  assert.equal(vad.silences.length, 2);
});

test('breath keyframes dip and recover', () => {
  const kfs = breathKeyframes([{ start: 1.0, end: 1.3 }], { trimBefore: 0, durationFrames: 90 }, 30, 15);
  assert.equal(kfs[0]!.gain, 1);
  const dip = kfs.find((k) => k.frame === 30)!;
  assert.ok(Math.abs(dip.gain - Math.pow(10, -15 / 20)) < 1e-6);
  assert.equal(kfs[kfs.length - 1]!.frame, 90);
});

test('b-roll concepts and heuristic matching', () => {
  const words = 'When stock markets dip, investors panic. The chart shows a recovery.'.split(' ').map((w, i) => ({ w, s: i * 0.4, e: i * 0.4 + 0.3 }));
  const concepts = extractConcepts(words);
  assert.equal(concepts.length, 2);
  assert.ok(concepts[0]!.keywords.includes('markets'));
  const assets = [
    { id: 'a'.repeat(64), name: 'stock-market-chart.mp4', kind: 'video' as const, mime: 'video/mp4', size: 1, importedAt: '' },
    { id: 'b'.repeat(64), name: 'beach.jpg', kind: 'image' as const, mime: 'image/jpeg', size: 1, importedAt: '' },
  ];
  const matches = matchAssetsHeuristic(concepts, assets);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0]!.assetName, 'stock-market-chart.mp4');
});

test('reframe: aspect parsing, smoothing, keyframes', () => {
  assert.equal(parseAspect('9:16'), 9 / 16);
  const frames = [
    { file: '1', width: 640, height: 360, faces: [{ x: 0.1, y: 0.2, w: 0.2, h: 0.3 }] },
    { file: '2', width: 640, height: 360, faces: [] },
    { file: '3', width: 640, height: 360, faces: [{ x: 0.5, y: 0.2, w: 0.2, h: 0.3 }] },
  ];
  const track = smoothTrack(frames, 5);
  assert.equal(track.length, 3);
  assert.ok(track[1]!.cx > 0.19 && track[1]!.cx < 0.21); // carried forward, smoothed
  const rf = reframeFromTrack(track, { trimBefore: 0, durationFrames: 60 }, 30, 9 / 16, 'face-track');
  assert.equal(rf.keyframes.length, 3);
  assert.equal(rf.keyframes[1]!.frame, 6);
});


test('repairTimestamps spreads collapsed tails up to the audio duration', () => {
  const words = [
    { w: 'a', s: 1, e: 1.2 },
    { w: 'b', s: 2, e: 2.2 },
    { w: 'c', s: 2.2, e: 2.2 },
    { w: 'd', s: 2.2, e: 2.2 },
    { w: 'e', s: 2.2, e: 2.2 },
  ];
  const out = repairTimestamps(words, 5);
  assert.ok(out[2]!.s < out[3]!.s && out[3]!.s < out[4]!.s);
  assert.ok(out[4]!.e <= 5);
  assert.ok(out[2]!.s >= 2.2);
});


import { buildEnhanceFilter } from '../src/enhance.ts';
import { setupCommands } from '../src/setup.ts';

test('enhance filter chain', () => {
  const f = buildEnhanceFilter({ lufs: -16, denoise: true, strength: 0.5, rnnoiseModel: '/m/std.rnnn' });
  assert.ok(f.startsWith('highpass=f=75'));
  assert.ok(f.includes("arnndn=m='/m/std.rnnn':mix=0.55"));
  assert.ok(f.includes('deesser'));
  assert.ok(f.endsWith('loudnorm=I=-16:TP=-1.5:LRA=11'));
  const g = buildEnhanceFilter({ lufs: -14, denoise: false, strength: 0.5 });
  assert.ok(!g.includes('arnndn') && !g.includes('afftdn'));
  assert.ok(setupCommands('base.en')[0] === 'brew install whisper-cpp');
});


import { ripFormatArgs } from '../src/rip.ts';

test('rip format args', () => {
  assert.deepEqual(ripFormatArgs('audio').slice(0, 4), ['-f', 'ba/b', '-x', '--audio-format']);
  assert.ok(ripFormatArgs('720').join(' ').includes('res:720,codec:avc:m4a,ext:mp4:m4a'));
  assert.ok(ripFormatArgs('best').join(' ').includes('res,codec:avc:m4a,ext:mp4:m4a'));
});
