/**
 * @neon/fx-kit — the helpers FX pack components can rely on.
 *
 * Packs installed from outside the repo import ONLY `react`, `remotion`, `@neon/core` and this
 * module; the app provides all four at runtime (see docs/fx-packs.md). Keep this surface small
 * and additive — external packs compiled against an older kit must keep working.
 */
import { createContext, useContext } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { Project } from '@neon/core';

/** Templates are authored for 1080p; scale everything by the actual output height. */
export function useUiScale(): number {
  const { height } = useVideoConfig();
  return height / 1080;
}

export const MONO = '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';
export const SANS = 'Inter, "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif';

/** Triple-layer neon glow for `boxShadow` / `textShadow`. */
export function glow(color: string, strength = 1): string {
  return `0 0 ${12 * strength}px ${color}, 0 0 ${32 * strength}px ${color}, 0 0 ${64 * strength}px ${color}55`;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- timeline access ------------------------------------------------------------------
// Templates normally see only their own props. Components that react to the rest of the edit
// (captions from the transcripts, chapter markers, …) read the project from this context, which
// the timeline composition provides in the preview and in exports.

export interface TimelineContextValue {
  project: Project;
  /** Output frames per project frame: render fps ÷ project fps (1 unless an export overrides fps). */
  scale: number;
  /** Output frame where the enclosing clip's <Sequence> starts (0 outside a clip). */
  clipFrom: number;
}

export const TimelineProjectContext = createContext<TimelineContextValue | null>(null);

/** The project being rendered, or null outside the timeline (e.g. the FX library thumbnail). */
export function useTimelineProject(): Project | null {
  return useContext(TimelineProjectContext)?.project ?? null;
}

/**
 * Current position on the project timeline in project frames (the units of clip.startFrame and
 * of @neon/core's caption cues), or null outside the timeline. `useCurrentFrame()` counts from the
 * clip's start; this adds the start back and undoes an export fps override.
 */
export function useTimelineFrame(): number | null {
  const ctx = useContext(TimelineProjectContext);
  const frame = useCurrentFrame();
  return ctx ? (ctx.clipFrom + frame) / ctx.scale : null;
}
