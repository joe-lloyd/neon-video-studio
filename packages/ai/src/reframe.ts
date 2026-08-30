/** Face tracking for auto-reframe (16:9 → 9:16 etc.) using Apple Vision face rectangles. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Reframe } from '@neon/core';
import { runOrThrow } from './exec.ts';
import { probe } from './probe.ts';
import type { ToolPaths } from './tools.ts';

interface FrameFaces {
  file: string;
  width: number;
  height: number;
  faces: { x: number; y: number; w: number; h: number }[];
}

export interface TrackPoint {
  seconds: number;
  cx: number;
  cy: number;
  detected: boolean;
}

export function parseAspect(aspect: string): number {
  const m = /^(\d+(?:\.\d+)?)[:/x](\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(aspect);
  if (Number.isFinite(n) && n > 0) return n;
  throw new Error(`Invalid aspect "${aspect}" — use e.g. 9:16`);
}

/** Pick the largest face per frame, fill gaps by carrying forward, then smooth with an EMA. */
export function smoothTrack(frames: FrameFaces[], sampleFps: number, alpha = 0.35): TrackPoint[] {
  const raw: TrackPoint[] = frames.map((f, i) => {
    const face = [...f.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0];
    return face
      ? { seconds: i / sampleFps, cx: face.x + face.w / 2, cy: face.y + face.h / 2, detected: true }
      : { seconds: i / sampleFps, cx: 0.5, cy: 0.5, detected: false };
  });
  // Carry forward / backward when no face was found.
  let last: TrackPoint | null = null;
  for (const p of raw) {
    if (p.detected) last = p;
    else if (last) {
      p.cx = last.cx;
      p.cy = last.cy;
    }
  }
  let next: TrackPoint | null = null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const p = raw[i]!;
    if (p.detected) next = p;
    else if (next && !raw.slice(0, i).some((q) => q.detected)) {
      p.cx = next.cx;
      p.cy = next.cy;
    }
  }
  const out: TrackPoint[] = [];
  let ex = raw[0]?.cx ?? 0.5;
  let ey = raw[0]?.cy ?? 0.5;
  for (const p of raw) {
    ex = ex + alpha * (p.cx - ex);
    ey = ey + alpha * (p.cy - ey);
    out.push({ ...p, cx: ex, cy: ey });
  }
  return out;
}

export async function trackFaces(
  file: string,
  opts: { paths: ToolPaths; sampleFps: number; onProgress?: (p: number, message?: string) => void },
): Promise<{ track: TrackPoint[]; detectedRatio: number; sourceAspect: number }> {
  if (!opts.paths.vision) throw new Error('Face tracking needs the neon-vision helper (macOS + Xcode command line tools).');
  const info = await probe(opts.paths.ffprobe, file);
  const dir = await mkdtemp(join(tmpdir(), 'neon-faces-'));
  await mkdir(dir, { recursive: true });
  try {
    opts.onProgress?.(0.05, 'Sampling frames');
    await runOrThrow(opts.paths.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', `fps=${opts.sampleFps},scale=640:-2`, join(dir, '%06d.png')]);
    opts.onProgress?.(0.4, 'Detecting faces (Apple Vision)');
    const r = await runOrThrow(opts.paths.vision, ['faces', dir]);
    const frames = JSON.parse(r.stdout) as FrameFaces[];
    const track = smoothTrack(frames, opts.sampleFps);
    const detected = track.filter((t) => t.detected).length;
    opts.onProgress?.(0.95, `Faces in ${detected}/${track.length} samples`);
    return { track, detectedRatio: frames.length ? detected / frames.length : 0, sourceAspect: info.width && info.height ? info.width / info.height : 16 / 9 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Convert a track (source seconds) into clip-local reframe keyframes. */
export function reframeFromTrack(
  track: TrackPoint[],
  clip: { trimBefore: number; durationFrames: number },
  fps: number,
  targetAspect: number,
  mode: Reframe['mode'],
): Reframe {
  const keyframes = track
    .map((t) => ({ frame: Math.round(t.seconds * fps) - clip.trimBefore, cx: Math.min(1, Math.max(0, t.cx)), cy: Math.min(1, Math.max(0, t.cy)), zoom: 1 }))
    .filter((k) => k.frame >= -fps && k.frame <= clip.durationFrames + fps)
    .map((k) => ({ ...k, frame: Math.max(0, Math.min(clip.durationFrames, k.frame)) }));
  const dedup = new Map<number, (typeof keyframes)[number]>();
  for (const k of keyframes) dedup.set(k.frame, k);
  return { mode, targetAspect, keyframes: [...dedup.values()].sort((a, b) => a.frame - b.frame) };
}
