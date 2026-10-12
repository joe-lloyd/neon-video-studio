/**
 * Offline audio mix for an export. The page reports, for every rendered frame, which media are
 * audible and where they are (`AudioFrameEntry`); here those reports become contiguous segments
 * (same source, same rate, media time advancing by rate/fps per frame), each segment's source
 * range is decoded with ffmpeg to 48 kHz stereo float, gain-ramped between the per-frame volumes
 * and summed. The mix is produced in fixed time windows so memory stays bounded for long renders.
 */
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { AudioFrameEntry } from './protocol.ts';
import { defaultBinaries, ffmpegInput, probeMedia, type FfmpegBinaries } from './probe.ts';

export const MIX_SAMPLE_RATE = 48_000;
export const MIX_CHANNELS = 2;

export interface AudioSegment {
  src: string;
  playbackRate: number;
  /** Output frame (0-based within the render) at which the segment starts. */
  startFrame: number;
  /** Source position (seconds, media time) at startFrame. */
  mediaStart: number;
  /** Linear gain per frame, one entry per frame of the segment. */
  volumes: number[];
}

/**
 * Group per-frame audio reports into contiguous segments. An entry continues an open segment
 * when it has the same source and rate and its media time is where that segment would be one
 * frame later (within a quarter frame); anything else starts a new segment (a cut, a loop, a
 * second clip of the same file).
 */
export function groupAudioSegments(frames: readonly (readonly AudioFrameEntry[] | undefined)[], fps: number): AudioSegment[] {
  const done: AudioSegment[] = [];
  let open: AudioSegment[] = [];
  for (let f = 0; f < frames.length; f++) {
    const entries = frames[f] ?? [];
    const next: AudioSegment[] = [];
    const available = new Set(open);
    for (const e of entries) {
      if (!(e.volume > 0) || !Number.isFinite(e.mediaTime) || !(e.playbackRate > 0)) continue;
      let best: AudioSegment | null = null;
      let bestErr = Infinity;
      for (const seg of available) {
        if (seg.src !== e.src || seg.playbackRate !== e.playbackRate) continue;
        const expected = seg.mediaStart + ((f - seg.startFrame) * seg.playbackRate) / fps;
        const err = Math.abs(expected - e.mediaTime);
        const tolerance = (0.25 * Math.max(1, seg.playbackRate)) / fps;
        if (err <= tolerance && err < bestErr) {
          best = seg;
          bestErr = err;
        }
      }
      if (best) {
        available.delete(best);
        best.volumes.push(e.volume);
        next.push(best);
      } else {
        next.push({ src: e.src, playbackRate: e.playbackRate, startFrame: f, mediaStart: e.mediaTime, volumes: [e.volume] });
      }
    }
    for (const seg of available) done.push(seg);
    open = next;
  }
  done.push(...open);
  return done.sort((a, b) => a.startFrame - b.startFrame);
}

/**
 * Gain of a segment at `framePos` frames after its start (fractional): linear between the
 * per-frame volumes, each volume anchored at the start of its frame; the last one holds.
 */
export function segmentGainAt(volumes: readonly number[], framePos: number): number {
  if (volumes.length === 0) return 0;
  if (framePos <= 0) return volumes[0]!;
  const i = Math.floor(framePos);
  if (i >= volumes.length - 1) return volumes[volumes.length - 1]!;
  const frac = framePos - i;
  return volumes[i]! + (volumes[i + 1]! - volumes[i]!) * frac;
}

/** atempo only accepts 0.5–2 (per instance); chain instances for rates outside that. */
export function atempoChain(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r > 2) {
    out.push('atempo=2');
    r /= 2;
  }
  while (r < 0.5) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-9) out.push(`atempo=${Number(r.toFixed(6))}`);
  return out;
}

/** Soft knee above 0.95 so overs bend instead of wrapping or clicking; the result is within [-1, 1]. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.95) return x;
  const y = 0.95 + 0.05 * Math.tanh((a - 0.95) / 0.05);
  return x < 0 ? -y : y;
}

/** Decode `duration` seconds of output (after tempo change) starting at source time `from`, as interleaved stereo f32. */
async function decodeRange(bins: FfmpegBinaries, src: string, from: number, duration: number, rate: number, samples: number, signal?: AbortSignal): Promise<Float32Array> {
  const filters = ['aresample=48000', ...atempoChain(rate)];
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...(from > 0 ? ['-ss', from.toFixed(6)] : []),
    // Read a little more than needed; the output is cut to exactly `samples` below.
    '-t', (duration * rate + 0.25).toFixed(6),
    '-i', ffmpegInput(src),
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', filters.join(','),
    '-ac', String(MIX_CHANNELS), '-ar', String(MIX_SAMPLE_RATE),
    '-f', 'f32le', 'pipe:1',
  ];
  const want = samples * MIX_CHANNELS * 4;
  return new Promise((resolve, reject) => {
    const child = spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = Buffer.alloc(want);
    let got = 0;
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      if (got >= want) return;
      got += c.copy(out, got, 0, Math.min(c.length, want - got));
      if (got >= want) child.kill('SIGKILL');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`Could not run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('Render cancelled'));
      if (got < want && code !== 0) return reject(new Error(`Could not decode audio from ${src}: ${stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`));
      // Short sources leave the tail silent (Buffer.alloc zero-fills).
      resolve(new Float32Array(out.buffer, out.byteOffset, samples * MIX_CHANNELS));
    });
  });
}

export interface MixAudioOptions {
  /** Audio reports per rendered frame (index 0 = first rendered frame). */
  frames: readonly (readonly AudioFrameEntry[] | undefined)[];
  fps: number;
  /** Total rendered frames (the output is exactly totalFrames / fps seconds long). */
  totalFrames: number;
  /** Raw interleaved f32le stereo 48 kHz output file. */
  outputPath: string;
  /** Mix window length in seconds (default 30). */
  windowSeconds?: number;
  binaries?: FfmpegBinaries;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

export interface MixAudioResult {
  segments: number;
  /** Peak absolute sample before clip guarding. */
  peak: number;
  samples: number;
}

/** Mix all audible media into one raw f32le stereo 48 kHz file of exactly the render's length. */
export async function mixAudio(opts: MixAudioOptions): Promise<MixAudioResult> {
  const bins = opts.binaries ?? defaultBinaries();
  const { fps } = opts;
  const totalSamples = Math.round((opts.totalFrames / fps) * MIX_SAMPLE_RATE);
  const windowSamples = Math.max(MIX_SAMPLE_RATE, Math.round((opts.windowSeconds ?? 30) * MIX_SAMPLE_RATE));

  const segments: AudioSegment[] = [];
  for (const seg of groupAudioSegments(opts.frames, fps)) {
    const probe = await probeMedia(seg.src, bins);
    if (probe.audio) segments.push(seg);
  }
  if (segments.length) opts.onLog?.(`audio: mixing ${segments.length} segment${segments.length === 1 ? '' : 's'}`);

  const file = await open(opts.outputPath, 'w');
  let peak = 0;
  try {
    for (let w0 = 0; w0 < totalSamples; w0 += windowSamples) {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Render cancelled');
      const w1 = Math.min(totalSamples, w0 + windowSamples);
      const mix = new Float32Array((w1 - w0) * MIX_CHANNELS);
      for (const seg of segments) {
        const s0 = Math.round((seg.startFrame / fps) * MIX_SAMPLE_RATE);
        const s1 = Math.round(((seg.startFrame + seg.volumes.length) / fps) * MIX_SAMPLE_RATE);
        const a = Math.max(s0, w0);
        const b = Math.min(s1, w1);
        if (b <= a) continue;
        if (seg.volumes.every((v) => v <= 0)) continue;
        // Output seconds since the segment start → media seconds via the playback rate (input -ss
        // is relative to the container start, like media time).
        const outOffset = (a - s0) / MIX_SAMPLE_RATE;
        const from = seg.mediaStart + outOffset * seg.playbackRate;
        const pcm = await decodeRange(bins, seg.src, from, (b - a) / MIX_SAMPLE_RATE, seg.playbackRate, b - a, opts.signal);
        for (let i = 0; i < b - a; i++) {
          const framePos = ((a + i) / MIX_SAMPLE_RATE) * fps - seg.startFrame;
          const g = segmentGainAt(seg.volumes, framePos);
          if (g === 0) continue;
          const o = (a + i - w0) * MIX_CHANNELS;
          mix[o] = mix[o]! + pcm[i * 2]! * g;
          mix[o + 1] = mix[o + 1]! + pcm[i * 2 + 1]! * g;
        }
      }
      for (let i = 0; i < mix.length; i++) {
        const v = mix[i]!;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        if (abs > 0.95) mix[i] = softClip(v);
      }
      await file.write(new Uint8Array(mix.buffer, mix.byteOffset, mix.byteLength));
    }
  } finally {
    await file.close();
  }
  return { segments: segments.length, peak, samples: totalSamples };
}
