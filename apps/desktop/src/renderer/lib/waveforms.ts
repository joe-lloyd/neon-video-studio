/**
 * Renderer-side waveform peaks: fetched once per asset from the control server, shared by every
 * clip that references the asset (splits, trims and duplicates all slice the same array).
 *
 * `null` = not available (still loading, no ffmpeg, or asset missing) → the clip falls back to
 * the neutral stripe pattern. An empty array = the asset has no audio → nothing is drawn.
 */
import { useEffect, useState } from 'react';

/** Peaks per second of source audio; must match WAVEFORM_RATE in main/waveforms.ts. */
export const WAVEFORM_RATE = 100;

const cache = new Map<string, Promise<Uint8Array | null>>();
const settled = new Map<string, Uint8Array | null>();

export function loadWaveform(base: string, assetId: string): Promise<Uint8Array | null> {
  const key = `${base}/${assetId}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetch(`${base}/waveforms/${assetId}`)
      .then(async (res) => {
        if (res.status === 204) return new Uint8Array(0);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      })
      .catch(() => null)
      .then((peaks) => {
        settled.set(key, peaks);
        // Let a transient failure retry on the next mount instead of pinning `null` forever.
        if (peaks === null) cache.delete(key);
        return peaks;
      });
    cache.set(key, pending);
  }
  return pending;
}

export function useWaveform(base: string, assetId: string | null): Uint8Array | null {
  const key = assetId ? `${base}/${assetId}` : null;
  const [peaks, setPeaks] = useState<Uint8Array | null>(() => (key ? settled.get(key) ?? null : null));
  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    const known = settled.get(`${base}/${assetId}`);
    if (known !== undefined) {
      setPeaks(known);
      if (known !== null) return;
    }
    void loadWaveform(base, assetId).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [base, assetId]);
  return peaks;
}

/** Max peak (0..255) over source seconds [t0, t1). */
export function peakBetween(peaks: Uint8Array, t0: number, t1: number): number {
  const from = Math.max(0, Math.floor(t0 * WAVEFORM_RATE));
  const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil(t1 * WAVEFORM_RATE)));
  let max = 0;
  for (let i = from; i < to; i++) if (peaks[i]! > max) max = peaks[i]!;
  return max;
}
