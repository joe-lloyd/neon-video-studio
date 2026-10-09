/**
 * Stills and contact sheets: which frames to capture and how a sheet lays them out.
 * All frames are project frames. Pure, so the app, the headless CLI and the composition agree.
 */
import type { SheetRequest, StillRequest } from './schemas.ts';
import { framesToTimecode, parseTimecode } from './timecode.ts';

export const MAX_SHEET_FRAMES = 100;
export const DEFAULT_SHEET_COUNT = 12;

export type SheetPick = { by: 'count'; count: number } | { by: 'every'; every: number };

/** Frames for a sheet over the inclusive range [from, to]. */
export function sheetFrames(from: number, to: number, pick: SheetPick): number[] {
  if (to < from) throw new Error(`Sheet range ends (${to}) before it starts (${from})`);
  const span = to - from + 1;
  switch (pick.by) {
    case 'count': {
      const n = Math.min(pick.count, span);
      // The middle of each of n equal slices: never the black first frame, never a repeat.
      return Array.from({ length: n }, (_, i) => from + Math.floor(((i + 0.5) * span) / n));
    }
    case 'every': {
      if (pick.every < 1) throw new Error('every must be at least 1 frame');
      const n = Math.floor((span - 1) / pick.every) + 1;
      if (n > MAX_SHEET_FRAMES) throw new Error(`That is ${n} frames; a sheet holds at most ${MAX_SHEET_FRAMES}. Use a larger every or a shorter range.`);
      return Array.from({ length: n }, (_, i) => from + i * pick.every);
    }
    default: {
      const unreachable: never = pick;
      throw new Error(`Unknown sheet pick ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Resolve a still request's `at` against the timeline; past the end is an error, not a clamp. */
export function stillFrame(req: Pick<StillRequest, 'at'>, fps: number, durationFrames: number): number {
  const at = parseTimecode(req.at, fps);
  if (durationFrames <= 0) throw new Error('Timeline is empty, nothing to capture');
  if (at >= durationFrames) throw new Error(`${framesToTimecode(at, fps)} is past the end of the timeline (${framesToTimecode(durationFrames, fps)})`);
  return at;
}

/** Resolve a sheet request (default: 12 frames over the whole timeline). */
export function sheetFramesFor(req: Pick<SheetRequest, 'from' | 'to' | 'count' | 'every'>, fps: number, durationFrames: number): number[] {
  if (durationFrames <= 0) throw new Error('Timeline is empty, nothing to capture');
  const last = durationFrames - 1;
  const from = req.from === undefined ? 0 : Math.min(parseTimecode(req.from, fps), last);
  const to = req.to === undefined ? last : Math.min(parseTimecode(req.to, fps), last);
  const pick: SheetPick = req.every !== undefined ? { by: 'every', every: parseTimecode(req.every, fps) } : { by: 'count', count: req.count ?? DEFAULT_SHEET_COUNT };
  return sheetFrames(from, to, pick);
}

export interface SheetCell {
  frame: number;
  x: number;
  y: number;
}

export interface SheetLayout {
  width: number;
  height: number;
  cols: number;
  rows: number;
  gap: number;
  cellWidth: number;
  cellHeight: number;
  /** Strip under each cell for its timecode. */
  labelHeight: number;
  cells: SheetCell[];
}

/** Grid for a sheet `width` pixels wide whose cells keep the project's aspect ratio. */
export function sheetLayout(opts: { frames: number[]; cols: number; width: number; source: { width: number; height: number } }): SheetLayout {
  const { frames, width, source } = opts;
  if (frames.length === 0) throw new Error('A sheet needs at least one frame');
  const cols = Math.max(1, Math.min(opts.cols, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const gap = Math.max(4, Math.round(width / 160));
  const cellWidth = Math.floor((width - gap * (cols + 1)) / cols);
  if (cellWidth < 32) throw new Error(`${cols} columns do not fit in ${width}px; use fewer columns or a wider sheet`);
  const cellHeight = Math.round((cellWidth * source.height) / source.width);
  const labelHeight = Math.max(14, Math.round(cellWidth / 16));
  // Centre the grid when the columns do not divide the width exactly.
  const left = Math.floor((width - cols * cellWidth - (cols - 1) * gap) / 2);
  const cells = frames.map((frame, i) => ({
    frame,
    x: left + (i % cols) * (cellWidth + gap),
    y: gap + Math.floor(i / cols) * (cellHeight + labelHeight + gap),
  }));
  return { width, height: gap + rows * (cellHeight + labelHeight + gap), cols, rows, gap, cellWidth, cellHeight, labelHeight, cells };
}

/** Default file name: `<project>-00-00-01-15.png`, or `<project>-sheet-<first>-<last>.png`. */
export function stillFileName(projectName: string, fps: number, frames: readonly number[]): string {
  const slug = projectName.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const tc = (f: number) => framesToTimecode(f, fps).replaceAll(':', '-');
  const first = frames[0] ?? 0;
  if (frames.length === 1) return `${slug}-${tc(first)}.png`;
  return `${slug}-sheet-${tc(first)}-${tc(frames[frames.length - 1] ?? first)}.png`;
}
