/**
 * End-to-end: bundle a tiny composition, render it in real Chrome, and check the MP4 frame by
 * frame. The source video encodes its frame number in its brightness (Y = 6·N), so every output
 * frame proves which source frame the frame server delivered. Skips without ffmpeg or Chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleComposition, renderMedia, resolveBrowserExecutable } from '../src/node/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

function has(cmd: string): boolean {
  return spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
}

async function chromeAvailable(): Promise<boolean> {
  try {
    await resolveBrowserExecutable({ allowDownload: false });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args: string[]): Buffer {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout;
}

function probe(file: string): { streams: { codec_type: string; width?: number; height?: number; nb_frames?: string; codec_name: string }[] } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,nb_frames', '-of', 'json', file]);
  return JSON.parse(r.stdout.toString());
}

const skip = !has('ffmpeg') || !has('ffprobe') ? 'ffmpeg/ffprobe not available' : !(await chromeAvailable()) ? 'Chrome not available' : false;

test('renderMedia: frame-accurate video, trims, sequences and mixed audio', { skip, timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-motion-e2e-'));
  try {
    const video = join(dir, 'counter.mp4');
    const tone = join(dir, 'tone.wav');
    // 40 frames at 30 fps, luma = 6·N, with B-frames and short GOPs to exercise seeking.
    ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30,geq=lum='N*6':cb=128:cr=128", '-frames:v', '40', '-c:v', 'libx264', '-g', '12', '-bf', '2', '-pix_fmt', 'yuv420p', video]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100', '-c:a', 'pcm_s16le', tone]);

    const entry = [
      `import { registerRenderRoot } from ${JSON.stringify(join(pkgRoot, 'src/render-page.tsx'))};`,
      `import { E2EComposition } from ${JSON.stringify(join(here, 'fixtures/e2e-composition.tsx'))};`,
      'registerRenderRoot(E2EComposition);',
    ].join('\n');
    const bundle = await bundleComposition({ entry: { source: entry, resolveDir: pkgRoot }, outDir: join(dir, 'bundle') });

    const out = join(dir, 'out.mp4');
    const fps = 30;
    const frames = 30;
    const progress: number[] = [];
    const result = await renderMedia({
      bundleDir: bundle.dir,
      props: { video: pathToFileURL(video).href, audio: pathToFileURL(tone).href },
      composition: { width: 160, height: 90, fps, durationInFrames: frames },
      outputPath: out,
      crf: 12,
      concurrency: 3,
      onProgress: (p) => progress.push(p.progress),
    });
    console.log(`e2e: ${result.frames} frames, ${result.renderFps.toFixed(1)} frames/s render, ${result.durationMs} ms total`);
    assert.equal(progress.at(-1), 1);

    const info = probe(out);
    const v = info.streams.find((s) => s.codec_type === 'video')!;
    const a = info.streams.find((s) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 160);
    assert.equal(v.height, 90);
    assert.equal(Number((v as { nb_read_frames?: string }).nb_read_frames), frames);
    assert.ok(a, 'output has an audio stream');
    assert.equal(a.codec_name, 'aac');

    // Mean luma (limited-range Y plane, no conversion) of the centre of each frame — the video is
    // letterboxed to 90x90 in the middle.
    const raw = ffmpeg(['-i', out, '-vf', 'crop=40:40:60:25', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
    const size = 40 * 40;
    const frameBytes = size * 1.5;
    assert.equal(raw.length, frameBytes * frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += raw[f * frameBytes + i]!;
      const mean = sum / size;
      // Before the sequence starts: black (Y=16). After: source frame 5 + (f - 3).
      const expected = f < 3 ? 16 : (5 + f - 3) * 6;
      assert.ok(Math.abs(mean - expected) <= 2.5, `frame ${f}: mean luma ${mean.toFixed(1)}, expected ${expected}`);
    }

    // Audio: silent before frame 10 and after frame 20, a tone (lavfi sine: amplitude 1/8, rms ≈ 0.088) in between.
    const pcm = ffmpeg(['-i', out, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const rms = (fromSec: number, toSec: number) => {
      let acc = 0;
      const a0 = Math.floor(fromSec * 48000);
      const a1 = Math.min(samples.length, Math.floor(toSec * 48000));
      for (let i = a0; i < a1; i++) acc += samples[i]! ** 2;
      return Math.sqrt(acc / Math.max(1, a1 - a0));
    };
    assert.ok(rms(0, 0.3) < 0.003, `silence before the audio sequence (rms ${rms(0, 0.3)})`);
    assert.ok(rms(0.52, 0.64) > 0.06, `tone during the audio sequence (rms ${rms(0.52, 0.64)})`);
    assert.ok(rms(0.72, 0.98) < 0.003, `silence after the audio sequence (rms ${rms(0.72, 0.98)})`);
    // Fade-in over the first 5 frames of the sequence: quieter at its start than at full volume.
    assert.ok(rms(0.34, 0.38) < rms(0.52, 0.64) * 0.6, 'fade-in ramps the gain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderMedia reports stuck frames and missing sources clearly and leaves no output', { skip, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-motion-e2e-fail-'));
  try {
    const entry = [
      `import { registerRenderRoot } from ${JSON.stringify(join(pkgRoot, 'src/render-page.tsx'))};`,
      `import { FailingComposition } from ${JSON.stringify(join(here, 'fixtures/failing-composition.tsx'))};`,
      'registerRenderRoot(FailingComposition);',
    ].join('\n');
    const bundle = await bundleComposition({ entry: { source: entry, resolveDir: pkgRoot }, outDir: join(dir, 'bundle') });
    const out = join(dir, 'out.mp4');
    const base = { bundleDir: bundle.dir, composition: { width: 64, height: 64, fps: 30, durationInFrames: 5 }, outputPath: out, concurrency: 1 };

    await assert.rejects(
      renderMedia({ ...base, props: { mode: 'hang', video: '' }, frameTimeoutMs: 1500 }),
      /Frame 0 did not finish rendering within 1500 ms\. Still waiting on delayRender\(\): "waiting for a webhook that never comes"/,
    );
    const missing = pathToFileURL(join(dir, 'nope.mp4')).href;
    await assert.rejects(renderMedia({ ...base, props: { mode: 'missing-video', video: missing } }), (err: Error) => {
      assert.match(err.message, /Frame 0 failed: .*Could not load image/);
      assert.match(err.message, /Frame server: .*nope\.mp4/);
      return true;
    });
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(out), false);

    // Cancelling via AbortSignal rejects promptly with the abort reason.
    const ctrl = new AbortController();
    const pending = renderMedia({ ...base, props: { mode: 'hang', video: '' }, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error('user cancelled')), 1500);
    await assert.rejects(pending, /user cancelled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
