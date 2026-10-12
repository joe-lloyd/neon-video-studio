import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioFrameEntry } from '../src/node/protocol.ts';
import { atempoChain, groupAudioSegments, mixAudio, MIX_SAMPLE_RATE, segmentGainAt, softClip } from '../src/node/audio.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const at = (src: string, mediaTime: number, volume = 1, playbackRate = 1): AudioFrameEntry => ({ src, mediaTime, volume, playbackRate });

test('groupAudioSegments joins frames whose media time advances by rate/fps', () => {
  const fps = 30;
  const frames: AudioFrameEntry[][] = [];
  for (let f = 0; f < 10; f++) frames.push([at('a', 2 + f / fps, (f + 1) / 10)]);
  const segs = groupAudioSegments(frames, fps);
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.startFrame, 0);
  close(segs[0]!.mediaStart, 2);
  assert.deepEqual(segs[0]!.volumes, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
});

test('groupAudioSegments splits on cuts, gaps, rate changes and sources', () => {
  const fps = 25;
  const frames: (AudioFrameEntry[] | undefined)[] = [
    [at('a', 0)],
    [at('a', 1 / fps)],
    [at('a', 5)], // jump (a cut to a different part of the file)
    [at('a', 5 + 1 / fps)],
    [], // gap
    [at('a', 5 + 3 / fps)],
    [at('a', 5 + 4 / fps, 1, 2)], // rate change
    [at('b', 0), at('a', 5 + 4 / fps + 2 / fps, 1, 2)],
    undefined,
  ];
  const segs = groupAudioSegments(frames, fps);
  const summary = segs.map((s) => `${s.src}@${s.startFrame}x${s.volumes.length}r${s.playbackRate}`);
  assert.deepEqual(summary, ['a@0x2r1', 'a@2x2r1', 'a@5x1r1', 'a@6x2r2', 'b@7x1r1']);
});

test('groupAudioSegments keeps two overlapping clips of the same file apart', () => {
  const fps = 30;
  const frames: AudioFrameEntry[][] = [];
  for (let f = 0; f < 5; f++) frames.push([at('a', f / fps, 1), at('a', 10 + f / fps, 0.5)]);
  const segs = groupAudioSegments(frames, fps);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => s.volumes.length), [5, 5]);
  assert.deepEqual(segs.map((s) => Math.round(s.mediaStart)).sort((x, y) => x - y), [0, 10]);
});

test('groupAudioSegments ignores silent and invalid entries', () => {
  const segs = groupAudioSegments([[at('a', 0, 0)], [at('a', Number.NaN)], [at('a', 0, 1, 0)]], 30);
  assert.equal(segs.length, 0);
});

test('segmentGainAt interpolates linearly between per-frame volumes and holds the last', () => {
  const v = [0, 1, 0.5];
  close(segmentGainAt(v, -1), 0);
  close(segmentGainAt(v, 0), 0);
  close(segmentGainAt(v, 0.25), 0.25);
  close(segmentGainAt(v, 1), 1);
  close(segmentGainAt(v, 1.5), 0.75);
  close(segmentGainAt(v, 2), 0.5);
  close(segmentGainAt(v, 7), 0.5);
  close(segmentGainAt([], 0), 0);
});

test('atempoChain stays inside atempo limits', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(1.5), ['atempo=1.5']);
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(5), ['atempo=2', 'atempo=2', 'atempo=1.25']);
});

test('softClip passes the normal range and bends overs below 1', () => {
  close(softClip(0.5), 0.5);
  close(softClip(-0.95), -0.95);
  assert.ok(softClip(1.05) < 1 && softClip(1.05) > 0.95);
  assert.ok(softClip(-3) >= -1 && softClip(-3) < -0.95);
  assert.ok(softClip(1.2) > softClip(1.0), 'monotonic');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('mixAudio decodes, ramps, sums and lengths the mix exactly', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-mix-'));
  try {
    // A constant (DC) source makes gains directly measurable: 0.5 full scale, stereo.
    const dc = join(dir, 'dc.wav');
    const silentVideo = join(dir, 'video-only.mp4');
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.5|0.5:s=48000:d=4', '-c:a', 'pcm_f32le', dc]);
    assert.equal(gen.status, 0, gen.stderr.toString());
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=10:d=1', '-c:v', 'libx264', silentVideo]);
    const src = pathToFileURL(dc).href;
    const noAudio = pathToFileURL(silentVideo).href;
    const fps = 10;
    const total = 30; // 3 s
    const frames: AudioFrameEntry[][] = [];
    for (let f = 0; f < total; f++) {
      const entries: AudioFrameEntry[] = [];
      // Frames 5–14: fade from 0 to 0.9 over 10 frames; frames 20–24: two overlapping copies at 1 → clipped.
      if (f >= 5 && f < 15) entries.push(at(src, (f - 5) / fps, (f - 5) / 10));
      if (f >= 20 && f < 25) entries.push(at(src, (f - 20) / fps, 1), at(src, 2 + (f - 20) / fps, 1.5));
      entries.push(at(noAudio, f / fps)); // no audio stream: skipped, not an error
      frames.push(entries);
    }
    const out = join(dir, 'mix.f32');
    const result = await mixAudio({ frames, fps, totalFrames: total, outputPath: out, windowSeconds: 1 });
    assert.equal(result.segments, 3);
    const pcm = new Float32Array((await readFile(out)).buffer.slice(0));
    assert.equal(pcm.length, total / fps * MIX_SAMPLE_RATE * 2);
    const sample = (sec: number) => pcm[Math.round(sec * MIX_SAMPLE_RATE) * 2]!;
    close(sample(0.2), 0, 1e-6);
    // Gain at t: (t·fps − 5) / 10 between frames 5 and 14, times the 0.5 DC level.
    close(sample(0.75), 0.5 * 0.25, 2e-3);
    close(sample(1.2), 0.5 * 0.7, 2e-3);
    close(sample(1.45), 0.5 * 0.9, 2e-3); // last volume holds through the last frame
    close(sample(1.7), 0, 1e-6);
    // 0.5·1 + 0.5·1.5 = 1.25 → soft-clipped below 1.
    assert.ok(sample(2.2) > 0.95 && sample(2.2) < 1, `clip guard (${sample(2.2)})`);
    assert.ok(result.peak > 1.2);
    close(sample(2.8), 0, 1e-6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
