import { volumeAt, type VolumeKeyframe } from '@neon/core';
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
 * Build clip-local volume keyframes that dip by `reductionDb` over each breath, with 40 ms ramps.
 * Existing keyframes are replaced (this is the whole envelope for the clip).
 */
export function breathKeyframes(
  breaths: Segment[],
  clip: { trimBefore: number; durationFrames: number },
  fps: number,
  reductionDb: number,
): VolumeKeyframe[] {
  const gain = Math.pow(10, -Math.abs(reductionDb) / 20);
  const ramp = Math.max(1, Math.round(fps * 0.04));
  const kfs: VolumeKeyframe[] = [];
  for (const b of breaths) {
    const s = Math.round(b.start * fps) - clip.trimBefore;
    const e = Math.round(b.end * fps) - clip.trimBefore;
    if (e <= 0 || s >= clip.durationFrames) continue;
    const a = Math.max(0, s);
    const z = Math.min(clip.durationFrames, e);
    kfs.push({ frame: Math.max(0, a - ramp), gain: 1 }, { frame: a, gain }, { frame: z, gain }, { frame: Math.min(clip.durationFrames, z + ramp), gain: 1 });
  }
  // Sort and de-duplicate frames (later wins), keep unity at both ends.
  const map = new Map<number, number>();
  map.set(0, 1);
  for (const k of kfs) map.set(k.frame, k.gain);
  map.set(clip.durationFrames, 1);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([frame, g]) => ({ frame, gain: g }));
}

/**
 * Merge full-mute spans into a clip's existing volume envelope: each source-time segment drops the
 * gain to 0 with 40 ms ramps, keyframes previously inside the span are removed, and the envelope
 * outside the spans is preserved (sampled at the ramp edges). Used by audio-only word cuts.
 */
export function muteRangeKeyframes(
  existing: VolumeKeyframe[] | undefined,
  segments: Segment[],
  clip: { trimBefore: number; durationFrames: number },
  fps: number,
): VolumeKeyframe[] {
  const ramp = Math.max(1, Math.round(fps * 0.04));
  const pts = new Map<number, number>();
  for (const k of existing ?? []) pts.set(k.frame, k.gain);
  for (const seg of segments) {
    const s = Math.round(seg.start * fps) - clip.trimBefore;
    const e = Math.round(seg.end * fps) - clip.trimBefore;
    if (e <= 0 || s >= clip.durationFrames) continue;
    const a = Math.max(0, s);
    const z = Math.min(clip.durationFrames, e);
    const rampIn = Math.max(0, a - ramp);
    const rampOut = Math.min(clip.durationFrames, z + ramp);
    const gainIn = volumeAt(existing, rampIn);
    const gainOut = volumeAt(existing, rampOut);
    for (const f of [...pts.keys()]) if (f >= rampIn && f <= rampOut) pts.delete(f);
    pts.set(rampIn, gainIn);
    pts.set(a, 0);
    pts.set(z, 0);
    pts.set(rampOut, gainOut);
  }
  if (!pts.has(0)) pts.set(0, volumeAt(existing, 0));
  return [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([frame, gain]) => ({ frame, gain }));
}
