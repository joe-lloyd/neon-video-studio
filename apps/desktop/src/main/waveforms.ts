/**
 * Waveform peaks for timeline clips: one max-amplitude byte per 10 ms of source audio.
 *
 * Computed once per asset (content hash) by streaming mono PCM out of ffmpeg and reducing it
 * bucket by bucket — nothing is buffered, so hour-long files cost constant memory. Results are
 * cached in ~/.neon-video/waveforms/<hash>.peaks and served by the control server; the renderer
 * slices them per clip (trim + zoom) and draws them on a canvas. An empty file means "no audio
 * stream", so video-only assets are probed exactly once.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { which } from '@neon/ai';
import { neonHome } from '@neon/core/node';
import type { AssetManager } from './assets.ts';

/** Buckets per second of source audio. Shared with the renderer via the X-Waveform-Rate header. */
export const WAVEFORM_RATE = 100;
const SAMPLE_RATE = 8000;
const SAMPLES_PER_BUCKET = SAMPLE_RATE / WAVEFORM_RATE;

export class WaveformCache {
  private readonly assets: AssetManager;
  private readonly inflight = new Map<string, Promise<Uint8Array | null>>();
  private readonly memory = new Map<string, Uint8Array>();

  constructor(assets: AssetManager) {
    this.assets = assets;
  }

  get dir(): string {
    return join(neonHome(), 'waveforms');
  }

  /** Peaks for an asset: cached → disk → computed. `null` when the asset or ffmpeg is unavailable. */
  get(hash: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return Promise.resolve(null);
    const hit = this.memory.get(hash);
    if (hit) return Promise.resolve(hit);
    let pending = this.inflight.get(hash);
    if (!pending) {
      pending = this.load(hash).finally(() => this.inflight.delete(hash));
      this.inflight.set(hash, pending);
    }
    return pending;
  }

  /** Fire-and-forget precompute (used right after import so the timeline never waits). */
  warm(hash: string): void {
    void this.get(hash).catch(() => undefined);
  }

  private async load(hash: string): Promise<Uint8Array | null> {
    const file = join(this.dir, `${hash}.peaks`);
    try {
      const cached = new Uint8Array(await readFile(file));
      this.memory.set(hash, cached);
      return cached;
    } catch {
      /* not cached yet */
    }
    const source = await this.assets.resolveFile(hash);
    if (!source) return null;
    const ffmpeg = await which('ffmpeg');
    if (!ffmpeg) return null;
    const peaks = await computePeaks(ffmpeg, source);
    if (!peaks) return null;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, peaks);
    await rename(tmp, file);
    this.memory.set(hash, peaks);
    return peaks;
  }
}

/**
 * Stream `-f s16le` mono PCM from ffmpeg and keep the max |sample| per bucket, scaled to 0..255.
 * Resolves to an empty array when the file has no audio stream, `null` on a real failure.
 */
export function computePeaks(ffmpeg: string, file: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: number[] = [];
    let carry: number | null = null; // dangling byte when a chunk splits a 16-bit sample
    let bucketMax = 0;
    let bucketCount = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      let offset = 0;
      if (carry !== null) {
        const sample = (chunk[0]! << 8) | carry; // little endian: carried byte is the low byte
        const v = Math.abs((sample << 16) >> 16);
        if (v > bucketMax) bucketMax = v;
        if (++bucketCount === SAMPLES_PER_BUCKET) {
          out.push(Math.min(255, Math.round((bucketMax / 32768) * 255)));
          bucketMax = 0;
          bucketCount = 0;
        }
        carry = null;
        offset = 1;
      }
      const end = offset + Math.floor((chunk.length - offset) / 2) * 2;
      for (let i = offset; i < end; i += 2) {
        const v = Math.abs(chunk.readInt16LE(i));
        if (v > bucketMax) bucketMax = v;
        if (++bucketCount === SAMPLES_PER_BUCKET) {
          out.push(Math.min(255, Math.round((bucketMax / 32768) * 255)));
          bucketMax = 0;
          bucketCount = 0;
        }
      }
      if (end < chunk.length) carry = chunk[end]!;
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (bucketCount > 0) out.push(Math.min(255, Math.round((bucketMax / 32768) * 255)));
      if (code === 0) return resolve(new Uint8Array(out));
      // ffmpeg exits non-zero when `-vn` leaves no stream to encode: a video without audio.
      // (Anything else — missing file, unreadable container — must stay uncached, so return null.)
      if (/does not contain any stream/i.test(stderr)) return resolve(new Uint8Array(0));
      console.warn(`[waveforms] ffmpeg failed (${code}): ${stderr.trim().slice(-200)}`);
      resolve(null);
    });
  });
}
