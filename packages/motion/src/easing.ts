/**
 * Easing functions: map progress t ∈ [0, 1] to eased progress. Composable with `Easing.in/out/inOut`
 * and usable as `interpolate(..., { easing })`.
 */
export type EasingFunction = (t: number) => number;

/** Cubic bézier through (0,0), (x1,y1), (x2,y2), (1,1) — the CSS `cubic-bezier()` curve. */
export function bezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) throw new RangeError('bezier x values must be within [0, 1]');
  if (x1 === y1 && x2 === y2) return (t) => t;
  // Polynomial coefficients of B(s) = ((a·s + b)·s + c)·s for each axis.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  /** Invert x(s) = x: Newton–Raphson, falling back to bisection where the slope is flat. */
  const solveS = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) return s;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveS(t));
  };
}

const linear: EasingFunction = (t) => t;

export const Easing = {
  step0: (t: number) => (t > 0 ? 1 : 0),
  step1: (t: number) => (t >= 1 ? 1 : 0),
  linear,
  /** Gentle inertial acceleration (the classic animation-library `ease`, i.e. cubic-bezier(0.42, 0, 1, 1)). */
  ease: bezier(0.42, 0, 1, 1),
  quad: (t: number) => t * t,
  cubic: (t: number) => t * t * t,
  poly: (n: number): EasingFunction => (t) => Math.pow(t, n),
  sin: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t: number) => 1 - Math.sqrt(1 - t * t),
  exp: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  /** Spring-like overshoot; bounciness 1 ≈ one visible oscillation. */
  elastic: (bounciness = 1): EasingFunction => {
    const p = bounciness * Math.PI;
    return (t) => 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p);
  },
  /** Pulls back before moving forward; s = 1.70158 gives the classic 10% overshoot. */
  back: (s = 1.70158): EasingFunction => (t) => t * t * ((s + 1) * t - s),
  bounce: (t: number): number => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) {
      const u = t - 1.5 / 2.75;
      return 7.5625 * u * u + 0.75;
    }
    if (t < 2.5 / 2.75) {
      const u = t - 2.25 / 2.75;
      return 7.5625 * u * u + 0.9375;
    }
    const u = t - 2.625 / 2.75;
    return 7.5625 * u * u + 0.984375;
  },
  bezier,
  in: (fn: EasingFunction): EasingFunction => fn,
  out: (fn: EasingFunction): EasingFunction => (t) => 1 - fn(1 - t),
  inOut: (fn: EasingFunction): EasingFunction => (t) => (t < 0.5 ? fn(t * 2) / 2 : 1 - fn((1 - t) * 2) / 2),
};
