/**
 * The script: pure helpers shared by the workspace, the prompter and the CLI. How long words take
 * to say is estimated at 180 words a minute, a brisk narration pace.
 */
import type { FrameRange, Script, ScriptCue, ScriptLine } from './types.ts';

const WORDS_PER_SECOND = 3;
/** Breath between planned lines when estimating a running time. */
const LINE_GAP_SECONDS = 0.45;

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
 * until it starts. `cues` must be in timeline order, as `scriptCues` returns them.
 */
export function cueStateAt(cues: readonly ScriptCue[], frame: number): { current: number; next: number; framesToNext: number | null } {
  const current = cues.findIndex((c) => frame >= c.startFrame && frame < c.startFrame + c.durationFrames);
  const next = cues.findIndex((c) => c.startFrame > frame);
  return { current, next, framesToNext: next === -1 ? null : cues[next]!.startFrame - frame };
}

/** The placed lines, in timeline order, as the prompter reads them. */
export function scriptCues(script: Script): ScriptCue[] {
  const cues: ScriptCue[] = [];
  for (const section of script.sections) {
    for (const line of section.lines) if (line.placed) cues.push({ id: line.id, ...line.placed, text: line.say });
  }
  return cues.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
}

/** Every line, in script order. */
export function scriptLines(script: Script): ScriptLine[] {
  return script.sections.flatMap((s) => s.lines);
}

export interface LineTiming {
  startFrame: number;
  durationFrames: number;
  /** True while the line is only planned: the time is a running estimate, not its place on the timeline. */
  estimated: boolean;
}

/**
 * When each line starts: its place on the timeline once recorded, otherwise an estimate that runs
 * on from the line before at narration pace.
 */
export function lineTimings(script: Script, fps: number): Map<string, LineTiming> {
  const out = new Map<string, LineTiming>();
  let cursor = 0;
  for (const line of scriptLines(script)) {
    if (line.placed) {
      out.set(line.id, { ...line.placed, estimated: false });
      cursor = line.placed.startFrame + line.placed.durationFrames;
      continue;
    }
    const durationFrames = Math.max(1, Math.round((speakingSeconds(line.say) + LINE_GAP_SECONDS) * fps));
    out.set(line.id, { startFrame: cursor, durationFrames, estimated: true });
    cursor += durationFrames;
  }
  return out;
}

/** Estimated running time of some lines, in seconds: recorded lines count their slot, planned ones their words. */
export function linesSeconds(lines: readonly ScriptLine[], fps: number): number {
  return lines.reduce((sum, l) => sum + (l.placed ? l.placed.durationFrames / fps : speakingSeconds(l.say) + LINE_GAP_SECONDS), 0);
}

/**
 * A line's place after [start, end) is cut from the timeline: later lines move left, a line across
 * the cut keeps what is left of it, and a line entirely inside it is no longer on the timeline.
 */
export function placementAfterCut(placed: NonNullable<ScriptLine['placed']>, { start, end }: FrameRange): ScriptLine['placed'] {
  const lineEnd = placed.startFrame + placed.durationFrames;
  if (lineEnd <= start) return placed;
  if (placed.startFrame >= end) return { startFrame: placed.startFrame - (end - start), durationFrames: placed.durationFrames };
  const kept = Math.max(0, start - placed.startFrame) + Math.max(0, lineEnd - end);
  return kept === 0 ? undefined : { startFrame: Math.min(placed.startFrame, start), durationFrames: kept };
}

/** Where a frame note lands after the cut: later notes move left, notes inside it move to the join. */
export function frameAfterCut(frame: number, { start, end }: FrameRange): number {
  if (frame < start) return frame;
  return frame >= end ? frame - (end - start) : start;
}

/** Neon 0.10 stored the script as bare timed cues; they become one recorded section. */
export function scriptFromCues(cues: readonly ScriptCue[]): Script {
  if (cues.length === 0) return { sections: [], notes: [] };
  const lines = [...cues]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((c) => ({ id: c.id, say: c.text, show: '', placed: { startFrame: c.startFrame, durationFrames: c.durationFrames } }));
  return { sections: [{ id: 'sec_script', title: 'Script', intent: '', status: 'approved', lines }], notes: [] };
}
