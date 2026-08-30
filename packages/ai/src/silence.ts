import { decodePcm, energyVad, frameEnergies, type Segment } from './pcm.ts';

export interface SilencePlan {
  noiseFloorDb: number;
  thresholdDb: number;
  /** Detected silences longer than minSilenceMs. */
  silences: Segment[];
  /** Portions to cut (each silence shortened to keepMs). */
  cuts: Segment[];
  removedSeconds: number;
}

/** Decide which parts of long pauses to remove so each pause becomes `keepMs`. */
export function planSilenceCuts(silences: Segment[], minSilenceMs: number, keepMs: number, edgePaddingMs = 0): Segment[] {
  const cuts: Segment[] = [];
  const keep = keepMs / 1000;
  for (const s of silences) {
    const len = s.end - s.start;
    if (len * 1000 < minSilenceMs) continue;
    const excess = len - keep;
    if (excess <= 0.02) continue;
    const start = s.start + keep / 2 + edgePaddingMs / 1000;
    const end = s.end - keep / 2 - edgePaddingMs / 1000;
    if (end > start) cuts.push({ start, end });
  }
  return cuts;
}

export async function analyseSilences(
  ffmpeg: string,
  file: string,
  opts: { thresholdDb?: number; minSilenceMs?: number; keepMs?: number } = {},
): Promise<SilencePlan> {
  const pcm = await decodePcm(ffmpeg, file);
  const frames = frameEnergies(pcm, 20);
  const vad = energyVad(frames, { thresholdDb: opts.thresholdDb, minSilenceMs: 80 });
  const minSilenceMs = opts.minSilenceMs ?? 400;
  const keepMs = opts.keepMs ?? 150;
  const silences = vad.silences.filter((s) => (s.end - s.start) * 1000 >= minSilenceMs);
  const cuts = planSilenceCuts(silences, minSilenceMs, keepMs);
  return {
    noiseFloorDb: vad.noiseFloorDb,
    thresholdDb: vad.speechThresholdDb,
    silences,
    cuts,
    removedSeconds: cuts.reduce((n, c) => n + (c.end - c.start), 0),
  };
}
