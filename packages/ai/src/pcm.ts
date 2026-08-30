/** Audio analysis on raw PCM — an energy-based voice activity detector that needs no ML runtime. */
import { spawn } from 'node:child_process';

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
  durationSeconds: number;
}

export async function decodePcm(ffmpeg: string, file: string, sampleRate = 16000): Promise<Pcm> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${err.trim().slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      resolve({ samples: new Float32Array(samples), sampleRate, durationSeconds: samples.length / sampleRate });
    });
  });
}

export interface EnergyFrames {
  /** dBFS per window */
  db: Float32Array;
  windowSeconds: number;
}

export function frameEnergies(pcm: Pcm, windowMs = 20): EnergyFrames {
  const win = Math.max(1, Math.round((pcm.sampleRate * windowMs) / 1000));
  const n = Math.floor(pcm.samples.length / win);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      const v = pcm.samples[base + j]!;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    db[i] = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
  }
  return { db, windowSeconds: win / pcm.sampleRate };
}

export function percentile(values: Float32Array, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return -120;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export interface Segment {
  start: number;
  end: number;
}

/** Contiguous windows where `predicate(db)` holds, as second ranges. */
export function segmentsWhere(frames: EnergyFrames, predicate: (db: number) => boolean, minSeconds = 0): Segment[] {
  const out: Segment[] = [];
  let start: number | null = null;
  for (let i = 0; i <= frames.db.length; i++) {
    const on = i < frames.db.length && predicate(frames.db[i]!);
    if (on && start === null) start = i;
    if (!on && start !== null) {
      const s = start * frames.windowSeconds;
      const e = i * frames.windowSeconds;
      if (e - s >= minSeconds) out.push({ start: s, end: e });
      start = null;
    }
  }
  return out;
}

export interface VadResult {
  noiseFloorDb: number;
  speechThresholdDb: number;
  speech: Segment[];
  silences: Segment[];
}

/**
 * Adaptive energy VAD: noise floor = 10th percentile, speech threshold = floor + 12 dB
 * (never above -25 dBFS so quiet speakers still count), silence = below the threshold.
 */
export function energyVad(frames: EnergyFrames, opts: { thresholdDb?: number; minSilenceMs?: number; minSpeechMs?: number } = {}): VadResult {
  const noiseFloorDb = percentile(frames.db, 0.1);
  const speechThresholdDb = opts.thresholdDb ?? Math.min(-25, Math.max(noiseFloorDb + 12, -60));
  const silences = segmentsWhere(frames, (db) => db < speechThresholdDb, (opts.minSilenceMs ?? 100) / 1000);
  const speech = segmentsWhere(frames, (db) => db >= speechThresholdDb, (opts.minSpeechMs ?? 60) / 1000);
  return { noiseFloorDb, speechThresholdDb, speech, silences };
}

/** Merge segments closer than `gap` seconds. */
export function mergeSegments(segments: Segment[], gap: number): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
