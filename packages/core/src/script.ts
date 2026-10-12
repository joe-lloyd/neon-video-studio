/**
 * The script as timed cues: pure helpers for the prompter. Where a cue starts and how long it
 * has come from the timeline; how long its words take to say is estimated at 180 words a minute, a brisk narration pace.
 */
import type { ScriptCue } from './types.ts';

const WORDS_PER_SECOND = 3;

/** Seconds a line takes to say at a steady narration pace. */
export function speakingSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND;
}

/** Whether the line needs more time than its slot on the timeline. */
export function cueIsTight(cue: ScriptCue, fps: number): boolean {
  return speakingSeconds(cue.text) > cue.durationFrames / fps;
}

/**
 * The cue being said at `frame` (or -1 between lines), the next one to come, and how many frames
 * until it starts. `cues` must be in timeline order, as the project stores them.
 */
export function cueStateAt(cues: readonly ScriptCue[], frame: number): { current: number; next: number; framesToNext: number | null } {
  const current = cues.findIndex((c) => frame >= c.startFrame && frame < c.startFrame + c.durationFrames);
  const next = cues.findIndex((c) => c.startFrame > frame);
  return { current, next, framesToNext: next === -1 ? null : cues[next]!.startFrame - frame };
}
