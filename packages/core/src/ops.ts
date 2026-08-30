import type { Clip, FrameRange, Track } from './types.ts';

export function clipEnd(clip: Pick<Clip, 'startFrame' | 'durationFrames'>): number {
  return clip.startFrame + clip.durationFrames;
}

export function overlaps(a: Pick<Clip, 'startFrame' | 'durationFrames'>, b: Pick<Clip, 'startFrame' | 'durationFrames'>): boolean {
  return a.startFrame < clipEnd(b) && b.startFrame < clipEnd(a);
}

export function sortTracks(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function sortClips<T extends Pick<Clip, 'startFrame' | 'id'>>(clips: T[]): T[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
}

/** Last frame occupied on a track (0 for an empty track). */
export function trackEnd(clips: Pick<Clip, 'startFrame' | 'durationFrames'>[]): number {
  return clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0);
}

/**
 * Find a start frame for a clip of `duration` frames as close as possible to `desired`
 * without overlapping any of `others`. Falls back to `desired` (allowing overlap) when the
 * track is too crowded — the caller decides whether that is acceptable.
 */
export function resolveFreePosition(
  others: Pick<Clip, 'startFrame' | 'durationFrames'>[],
  desired: number,
  duration: number,
): { startFrame: number; overlapping: boolean } {
  const start = Math.max(0, Math.round(desired));
  const sorted = sortClips(others.map((c, i) => ({ ...c, id: String(i) })));
  const fits = (s: number) => s >= 0 && !sorted.some((o) => overlaps({ startFrame: s, durationFrames: duration }, o));
  if (fits(start)) return { startFrame: start, overlapping: false };

  const collider = sorted.find((o) => overlaps({ startFrame: start, durationFrames: duration }, o));
  if (!collider) return { startFrame: start, overlapping: false };

  const after = clipEnd(collider);
  const before = collider.startFrame - duration;
  const candidates = [after, before].filter((s) => fits(s));
  if (candidates.length === 0) {
    // Walk forward through the gaps to find the first slot that fits.
    let cursor = after;
    for (const o of sorted) {
      if (o.startFrame >= cursor + duration) break;
      cursor = Math.max(cursor, clipEnd(o));
    }
    if (fits(cursor)) return { startFrame: cursor, overlapping: false };
    return { startFrame: start, overlapping: true };
  }
  candidates.sort((a, b) => Math.abs(a - start) - Math.abs(b - start));
  return { startFrame: candidates[0]!, overlapping: false };
}

/**
 * Plan an "insert edit": everything on the track at or after `at` moves right by `duration`;
 * a clip spanning `at` is split so its right half moves too.
 */
export interface RipplePlan {
  shift: { id: string; newStart: number }[];
  split: { id: string; at: number } | null;
}

export function planRippleInsert(trackClips: Clip[], at: number, duration: number): RipplePlan {
  const plan: RipplePlan = { shift: [], split: null };
  for (const clip of trackClips) {
    if (clip.startFrame >= at) {
      plan.shift.push({ id: clip.id, newStart: clip.startFrame + duration });
    } else if (clipEnd(clip) > at) {
      plan.split = { id: clip.id, at };
    }
  }
  return plan;
}

/** Snap `frame` to the closest of the candidate frames if within `threshold` frames. */
export function snapFrame(frame: number, candidates: number[], threshold: number): number {
  let best = frame;
  let bestDist = threshold + 1;
  for (const c of candidates) {
    const d = Math.abs(c - frame);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return bestDist <= threshold ? best : frame;
}

/** Merge overlapping/adjacent ranges (gap ≤ `gap` frames), sorted ascending. */
export function mergeRanges(ranges: FrameRange[], gap = 0): FrameRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: Math.max(0, Math.round(r.start)), end: Math.round(r.end) }))
    .sort((a, b) => a.start - b.start);
  const out: FrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function rangesTotal(ranges: FrameRange[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start), 0);
}

/** Convert a source-time range (seconds) of an asset to the timeline range it occupies within `clip`, or null. */
export function sourceSecondsToTimeline(
  clip: { startFrame: number; durationFrames: number; trimBefore: number },
  startSeconds: number,
  endSeconds: number,
  fps: number,
): FrameRange | null {
  const localStart = Math.round(startSeconds * fps) - clip.trimBefore;
  const localEnd = Math.round(endSeconds * fps) - clip.trimBefore;
  const start = Math.max(0, localStart);
  const end = Math.min(clip.durationFrames, localEnd);
  if (end <= start) return null;
  return { start: clip.startFrame + start, end: clip.startFrame + end };
}

/** Linear interpolation of volume keyframes at a clip-local frame (1 when no keyframes). */
export function volumeAt(keyframes: { frame: number; gain: number }[] | undefined, frame: number): number {
  if (!keyframes || keyframes.length === 0) return 1;
  if (frame <= keyframes[0]!.frame) return keyframes[0]!.gain;
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1]!;
    const b = keyframes[i]!;
    if (frame <= b.frame) {
      const t = b.frame === a.frame ? 1 : (frame - a.frame) / (b.frame - a.frame);
      return a.gain + (b.gain - a.gain) * t;
    }
  }
  return keyframes[keyframes.length - 1]!.gain;
}
