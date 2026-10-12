/**
 * Deterministic pseudo-random number in [0, 1) for a seed. Same seed → same value in every
 * process, which is what keeps preview and export frames identical.
 */
export function random(seed: number | string | null): number {
  if (seed === null) throw new Error('random(null) is not deterministic — pass a seed');
  const str = typeof seed === 'number' ? `n${seed}` : `s${seed}`;
  // FNV-1a over the seed, then a mulberry32 round to spread the bits.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
