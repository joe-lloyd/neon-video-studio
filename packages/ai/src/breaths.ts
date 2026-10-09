import { sourceSecondsToLocal, volumeAt, type VolumeKeyframe } from '@neon/core';
import { decodePcm, energyVad, frameEnergies, segmentsWhere, type Segment } from './pcm.ts';

export interface BreathAnalysis {
  breaths: Segment[];
  noiseFloorDb: number;
  speechThresholdDb: number;
}

/**
 * Heuristic breath / mouth-noise detector: low-energy vocal events (above the noise floor but well
 * below speech level) lasting 80–900 ms that sit between speech phrases. No ML model — documented
 * as a heuristic; swap in a classifier (YAMNet/Silero) here when one is available.
 */
export async function analyseBreaths(ffmpeg: string, file: string): Promise<BreathAnalysis> {
  const pcm = await decodePcm(ffmpeg, file);
  const frames = frameEnergies(pcm, 10);
  const vad = energyVad(frames, { minSilenceMs: 50, minSpeechMs: 60 });
  const low = vad.noiseFloorDb + 4;
  const high = vad.speechThresholdDb - 2;
  const candidates = segmentsWhere(frames, (db) => db > low && db < high, 0.08).filter((s) => s.end - s.start <= 0.9);
  // Keep only candidates not overlapping real speech and adjacent (≤ 600 ms) to a speech segment.
  const breaths = candidates.filter((c) => {
    const overlapsSpeech = vad.speech.some((sp) => c.start < sp.end - 0.02 && sp.start + 0.02 < c.end && sp.end - sp.start > 0.25);
    if (overlapsSpeech) return false;
    return vad.speech.some((sp) => Math.abs(sp.start - c.end) < 0.6 || Math.abs(c.start - sp.end) < 0.6);
  });
  return { breaths, noiseFloorDb: vad.noiseFloorDb, speechThresholdDb: vad.speechThresholdDb };
}

/**
 * Dip source-time segments of a clip's volume envelope to `gain` times the level already there (0
 * mutes), with 40 ms ramps. Keyframes inside a span are replaced and the envelope outside the spans
 * is kept, so dips compose: breaths softened after fillers were muted leave the mutes in place.
 */
export function dipKeyframes(
  existing: VolumeKeyframe[] | undefined,
  segments: Segment[],
  clip: { trimBefore: number; durationFrames: number; speed?: number },
  fps: number,
  gain: number,
): VolumeKeyframe[] {
  const ramp = Math.max(1, Math.round(fps * 0.04));
  const pts = new Map<number, number>();
  for (const k of existing ?? []) pts.set(k.frame, k.gain);
  const envelope = (): VolumeKeyframe[] => [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([frame, g]) => ({ frame, gain: g }));
  const level = (frame: number) => volumeAt(envelope(), frame);
  for (const seg of segments) {
    const local = sourceSecondsToLocal(clip, seg.start, seg.end, fps);
    if (!local) continue;
    const a = local.start;
    const z = local.end;
    const rampIn = Math.max(0, a - ramp);
    const rampOut = Math.min(clip.durationFrames, z + ramp);
    const gainIn = level(rampIn);
    const gainOut = level(rampOut);
    const inside = Math.min(level(a), level((a + z) / 2), level(z)) * gain;
    for (const f of [...pts.keys()]) if (f >= rampIn && f <= rampOut) pts.delete(f);
    pts.set(rampIn, gainIn);
    pts.set(a, inside);
    pts.set(z, inside);
    pts.set(rampOut, gainOut);
  }
  if (!pts.has(0)) pts.set(0, level(0));
  return envelope();
}
