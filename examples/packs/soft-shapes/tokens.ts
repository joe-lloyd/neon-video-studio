/**
 * Soft Shapes design tokens: a mint/teal tonal palette, pill shapes that square to 12px when
 * "active", springy overshoot-and-settle easing curves, procedural blob geometry, and matte
 * flatness (no glows, no shadows, no gradients; depth comes from tonal surface steps).
 */
import { Easing } from '@neon/motion';

export const PALETTE = {
  mint: '#7fd1c7', // hero accent
  teal: '#1f6f68', // primary on light surfaces
  mintContainer: '#c9f0ea',
  deepTeal: '#0f3b37',
  ink: '#1a1a1a',
  surfaceDark: '#101214',
  surfaceLight: '#f6f7f7',
  onSurfaceVariant: '#c4cfcd',
} as const;

/** Spring curves overshoot past 1 and settle; that is the pack's motion signature. */
export const easeSpringFast = Easing.bezier(0.34, 1.56, 0.64, 1);
export const easeSpringDefault = Easing.bezier(0.3, 1.3, 0.4, 1);
export const easeSpringSlow = Easing.bezier(0.35, 1.2, 0.45, 1);
/** Effects (opacity/color) get a plain settle; exits accelerate away. */
export const easeEffects = Easing.bezier(0.25, 0.8, 0.35, 1);
export const easeExit = Easing.bezier(0.4, 0, 0.9, 0.6);

/** Idle shapes are full pills; pressed/exiting shapes square up to 12px. */
export const RADIUS_PILL = 999;
export const RADIUS_ACTIVE = 12;

// ---- procedural blob geometry (400×400 viewBox) ----

export type BlobShape = 'burst' | 'petal' | 'clover' | 'scallop' | 'oval';

export const BLOB_SHAPES: BlobShape[] = ['burst', 'petal', 'clover', 'scallop', 'oval'];

const BLOB_SPECS: Record<BlobShape, { lobes: number; depth: number }> = {
  burst: { lobes: 12, depth: 0.16 },
  petal: { lobes: 8, depth: 0.3 },
  clover: { lobes: 4, depth: 0.38 },
  scallop: { lobes: 8, depth: 0.11 },
  oval: { lobes: 2, depth: 0.2 },
};

const POINTS = 72;
export const BLOB_VIEWBOX = 400;

/** Polar radii (0..1) sampled around the shape — same point count for every shape, so radii interpolate cleanly for morphing. */
export function blobRadii(shape: BlobShape): number[] {
  const { lobes, depth } = BLOB_SPECS[shape];
  return Array.from({ length: POINTS }, (_, i) => {
    const a = (i / POINTS) * Math.PI * 2;
    return 1 - depth * 0.5 + depth * 0.5 * Math.cos(a * lobes);
  });
}

/** Smooth closed path through the polar samples (Catmull-Rom converted to cubic beziers). */
export function blobPath(radii: number[]): string {
  const n = radii.length;
  const c = BLOB_VIEWBOX / 2;
  const rMax = BLOB_VIEWBOX * 0.475;
  const pts: [number, number][] = radii.map((r, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [c + rMax * r * Math.cos(a), c + rMax * r * Math.sin(a)];
  });
  const p = (i: number): [number, number] => pts[((i % n) + n) % n]!;
  let d = `M ${p(0)[0].toFixed(2)} ${p(0)[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

export function lerpRadii(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + ((b[i] ?? v) - v) * t);
}
