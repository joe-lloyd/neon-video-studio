/**
 * Pacing for screen recordings. A pause in the narration over a frozen screen is dead air and
 * gets cut; a pause while the screen is still changing (an install, a page loading) is sped up
 * instead, so the viewer sees it happen without waiting for it.
 */
import { run } from './exec.ts';
import type { Segment } from './pcm.ts';

export type PaceAction = { kind: 'cut'; start: number; end: number } | { kind: 'speed'; start: number; end: number; rate: number };

/** Parse `freezedetect` log lines into frozen spans (seconds). A freeze still open at EOF runs to `durationSeconds`. */
export function parseFreezes(log: string, durationSeconds: number): Segment[] {
  const out: Segment[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === 'start') open = t;
    else if (open !== null) {
      out.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null && durationSeconds > open) out.push({ start: open, end: durationSeconds });
  return out;
}

/** Frozen spans of a video's picture. Sampled at 10 fps and downscaled: pacing needs "is anything moving", not precision. */
export async function detectFreezes(ffmpeg: string, file: string, durationSeconds: number): Promise<Segment[]> {
  const r = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-vf', 'fps=10,scale=480:-2,freezedetect=n=0.003:d=0.4', '-f', 'null', '-']);
  if (r.code !== 0) throw new Error(`freezedetect failed: ${r.stderr.trim().split('\n').pop() ?? `exit ${r.code}`}`);
  return parseFreezes(r.stderr, durationSeconds);
}

/** Frozen pieces shorter than this are not worth a cut; they ride along in the speed-up. */
const MIN_CUT = 0.4;

/**
 * Keep `keepMs` of each pause (split over both edges); of the rest, cut what sits on a frozen
 * picture and play what is still changing at `rate`.
 */
export function planPacing(pauses: readonly Segment[], freezes: readonly Segment[], opts: { keepMs: number; rate: number }): PaceAction[] {
  const keep = opts.keepMs / 1000;
  const out: PaceAction[] = [];
  for (const p of pauses) {
    const start = p.start + keep / 2;
    const end = p.end - keep / 2;
    if (end - start < 0.1) continue;
    const frozen = freezes
      .map((f) => ({ start: Math.max(start, f.start), end: Math.min(end, f.end) }))
      .filter((f) => f.end - f.start >= MIN_CUT)
      .sort((a, b) => a.start - b.start);
    let cursor = start;
    for (const f of frozen) {
      if (f.start - cursor >= 0.1) out.push({ kind: 'speed', start: cursor, end: f.start, rate: opts.rate });
      out.push({ kind: 'cut', start: f.start, end: f.end });
      cursor = f.end;
    }
    if (end - cursor >= 0.1) out.push({ kind: 'speed', start: cursor, end, rate: opts.rate });
  }
  return out;
}
