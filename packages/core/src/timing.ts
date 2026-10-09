/**
 * Source ↔ timeline time for media clips, and the zoom camera. The one place that knows how
 * `trimBefore` and `speed` relate a clip's timeline frames to its asset's frames — every caller
 * (composition, AI cuts, captions, script panel, waveforms) goes through here.
 */
import type { ZoomRegion } from './types.ts';

/** The fields of a media clip that decide its timing. */
export interface ClipTiming {
  startFrame: number;
  durationFrames: number;
  trimBefore: number;
  speed?: number;
}

export const ZOOM_DEFAULT_RAMP = 15;

export function speedOf(clip: { speed?: number }): number {
  return clip.speed ?? 1;
}

/** Source frame shown at a timeline frame (fractional when the clip is re-timed). */
export function sourceFrameAt(clip: ClipTiming, timelineFrame: number): number {
  return clip.trimBefore + (timelineFrame - clip.startFrame) * speedOf(clip);
}

/** Timeline frame where a source frame plays in this clip, or null when the clip does not show it. */
export function timelineFrameAt(clip: ClipTiming, sourceFrame: number): number | null {
  const local = (sourceFrame - clip.trimBefore) / speedOf(clip);
  if (local < 0 || local >= clip.durationFrames) return null;
  return clip.startFrame + Math.round(local);
}

/** First source frame after the clip (exclusive end of what it plays). */
export function sourceEnd(clip: ClipTiming): number {
  return clip.trimBefore + clip.durationFrames * speedOf(clip);
}

/**
 * Clip-local frame range [start, end) covering a source range given in seconds, clamped to the
 * clip, or null when the clip does not play any of it.
 */
export function sourceSecondsToLocal(clip: Omit<ClipTiming, 'startFrame'>, startSeconds: number, endSeconds: number, fps: number): { start: number; end: number } | null {
  const s = speedOf(clip);
  const start = Math.max(0, Math.round((startSeconds * fps - clip.trimBefore) / s));
  const end = Math.min(clip.durationFrames, Math.round((endSeconds * fps - clip.trimBefore) / s));
  return end > start ? { start, end } : null;
}

export interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

const IDENTITY: Camera = { cx: 0.5, cy: 0.5, zoom: 1 };

function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const e = easeInOut(t);
  return { cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e, zoom: a.zoom + (b.zoom - a.zoom) * e };
}

/** Keep the zoomed window inside the picture: at zoom z the centre can move within [0.5/z, 1 − 0.5/z]. */
function clampCamera(c: Camera): Camera {
  const zoom = Math.max(1, c.zoom);
  const half = 0.5 / zoom;
  const clamp = (v: number) => Math.min(1 - half, Math.max(half, v));
  return { cx: clamp(c.cx), cy: clamp(c.cy), zoom };
}

function target(r: ZoomRegion): Camera {
  return clampCamera({ cx: r.cx, cy: r.cy, zoom: r.zoom });
}

/**
 * Camera at a source frame. Each region eases in from the previous state over `ramp` frames, holds,
 * then eases out after `end`. When the next region starts before that ease-out would finish, the
 * camera holds and then pans straight to it instead of zooming out and back in.
 */
export function zoomAt(zooms: readonly ZoomRegion[] | undefined, sourceFrame: number): Camera {
  if (!zooms || zooms.length === 0) return IDENTITY;
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  const rampOf = (r: ZoomRegion) => Math.max(0, r.ramp ?? ZOOM_DEFAULT_RAMP);
  // Chained when this region starts before the previous one would have finished zooming out.
  const chainedFrom = (i: number): ZoomRegion | null => {
    const prev = sorted[i - 1];
    return prev && sorted[i]!.start < prev.end + rampOf(prev) ? prev : null;
  };
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (sourceFrame < r.start) continue;
    const next = sorted[i + 1];
    if (sourceFrame < r.end) {
      const ramp = rampOf(r);
      const from = chainedFrom(i);
      if (ramp > 0 && sourceFrame < r.start + ramp) return clampCamera(lerpCamera(from ? target(from) : IDENTITY, target(r), (sourceFrame - r.start) / ramp));
      return target(r);
    }
    if (next && sourceFrame >= next.start) continue;
    // Between this region's end and the next start (or after the last region).
    if (next && chainedFrom(i + 1) === r) return target(r);
    const ramp = rampOf(r);
    if (ramp > 0 && sourceFrame < r.end + ramp) return clampCamera(lerpCamera(target(r), IDENTITY, (sourceFrame - r.end) / ramp));
  }
  return IDENTITY;
}

/**
 * Re-base clip-local keyframes onto the sub-range [from, to) of the clip: frames shift by −from,
 * points outside are dropped and the edges get interpolated points so the envelope is unchanged.
 */
export function sliceKeyframes<K extends { frame: number }>(kfs: readonly K[] | undefined, from: number, to: number, at: (frame: number) => K): K[] | undefined {
  if (!kfs || kfs.length === 0) return undefined;
  const inside = kfs.filter((k) => k.frame > from && k.frame < to).map((k) => ({ ...k, frame: k.frame - from }));
  return [{ ...at(from), frame: 0 }, ...inside, { ...at(to), frame: to - from }];
}
