/** ffprobe wrapper with a per-process cache, plus helpers shared by the frame server and the audio mixer. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export interface MediaProbe {
  /** Container start time in seconds (media time 0 maps to this timestamp). */
  startTime: number;
  duration: number | null;
  video: { width: number; height: number; fps: number | null; pixFmt: string | null } | null;
  audio: { sampleRate: number; channels: number } | null;
}

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export function defaultBinaries(): FfmpegBinaries {
  return {
    ffmpeg: process.env['NEON_FFMPEG_PATH'] || 'ffmpeg',
    ffprobe: process.env['NEON_FFPROBE_PATH'] || 'ffprobe',
  };
}

// ---- local copies of remote sources --------------------------------------------------------

const copies = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();
let copiesDir: string | null = null;

function copiesRoot(): string {
  if (!copiesDir) {
    copiesDir = mkdtempSync(join(tmpdir(), 'neon-sources-'));
    const dir = copiesDir;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return copiesDir;
}

async function download(src: string): Promise<string> {
  const res = await fetch(src);
  if (!res.ok || !res.body) throw new Error(`Could not fetch ${src}: HTTP ${res.status}`);
  const ext = extname(new URL(src).pathname).slice(0, 8);
  const file = join(copiesRoot(), `${createHash('sha1').update(src).digest('hex')}${ext}`);
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), createWriteStream(partial));
  await rename(partial, file);
  return file;
}

/**
 * A local file for a source. http(s) sources are downloaded once per process and decoded from
 * disk: ffmpeg's own HTTP client seeks with many range requests, which is slow and has proved
 * unreliable against some servers. file:// URLs map to their path; anything else passes through.
 */
export function localSource(src: string): Promise<string> {
  if (src.startsWith('file://')) return Promise.resolve(fileURLToPath(src));
  if (!/^https?:\/\//i.test(src)) return Promise.resolve(src);
  let hit = copies.get(src);
  if (!hit) {
    hit = download(src).then((file) => {
      resolved.set(src, file);
      return file;
    });
    copies.set(src, hit);
    hit.catch(() => copies.delete(src));
  }
  return hit;
}

/**
 * What ffmpeg should open for a source: its local copy once `localSource()` has fetched it
 * (probeMedia() always does, and every decode probes first), else the path or URL itself.
 */
export function ffmpegInput(src: string): string {
  if (src.startsWith('file://')) return fileURLToPath(src);
  return resolved.get(src) ?? src;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d || !Number.isFinite(n / d)) return null;
  return n / d;
}

export function runCapture(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Could not run ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr });
    });
  });
}

const cache = new Map<string, Promise<MediaProbe>>();

export function probeMedia(src: string, bins: FfmpegBinaries = defaultBinaries()): Promise<MediaProbe> {
  const key = `${bins.ffprobe}\n${src}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = probeUncached(src, bins);
    cache.set(key, hit);
    // Don't cache failures (a source may become reachable, e.g. a still-uploading asset).
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

async function probeUncached(src: string, bins: FfmpegBinaries): Promise<MediaProbe> {
  await localSource(src);
  const { code, stdout, stderr } = await runCapture(bins.ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,pix_fmt,sample_rate,channels:stream_disposition=attached_pic:format=start_time,duration',
    '-of', 'json',
    ffmpegInput(src),
  ], { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(`Could not read media ${src}: ${stderr.trim().split('\n').pop() || `ffprobe exited with ${code}`}`);
  const json = JSON.parse(stdout.toString('utf8')) as {
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      pix_fmt?: string;
      sample_rate?: string;
      channels?: number;
      disposition?: { attached_pic?: number };
    }[];
    format?: { start_time?: string; duration?: string };
  };
  const streams = json.streams ?? [];
  // Cover art in audio files shows up as a video stream; it is not a picture track.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const start = Number(json.format?.start_time);
  const duration = Number(json.format?.duration);
  return {
    startTime: Number.isFinite(start) ? start : 0,
    duration: Number.isFinite(duration) ? duration : null,
    video: v ? { width: v.width ?? 0, height: v.height ?? 0, fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate), pixFmt: v.pix_fmt ?? null } : null,
    audio: a ? { sampleRate: Number(a.sample_rate) || 48_000, channels: a.channels ?? 2 } : null,
  };
}

/** Forget cached probe results (tests). */
export function clearProbeCache(): void {
  cache.clear();
}
