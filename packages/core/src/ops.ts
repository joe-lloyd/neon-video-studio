import type { Clip, Track } from './types.ts';

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
