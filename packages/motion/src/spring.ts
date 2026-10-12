/**
 * Frame-based damped spring. Solved in closed form (no integration), so the value at a frame is
 * the same no matter which frames were rendered before it — preview and export always agree.
 */
export interface SpringConfig {
  damping: number;
  mass: number;
  stiffness: number;
  /** Stop at the target instead of overshooting it. */
  overshootClamping: boolean;
}

export const DEFAULT_SPRING_CONFIG: SpringConfig = { damping: 10, mass: 1, stiffness: 100, overshootClamping: false };

export interface SpringOptions {
  frame: number;
  fps: number;
  config?: Partial<SpringConfig>;
  from?: number;
  to?: number;
  /** Frames to wait before the spring starts. */
  delay?: number;
  /** Stretch or squeeze the spring so it settles in exactly this many frames. */
  durationInFrames?: number;
  /** Play the spring backwards (from `to` to `from`). */
  reverse?: boolean;
  /** Settling threshold used together with `durationInFrames` (fraction of the distance). */
  durationRestThreshold?: number;
}

/**
 * Normalised displacement remaining (1 → 0) after `t` seconds, starting at rest away from the target.
 * x(t) solves m·x'' + c·x' + k·x = 0 with x(0) = 1, x'(0) = 0.
 */
function displacement(t: number, { damping: c, mass: m, stiffness: k }: SpringConfig): number {
  if (t <= 0) return 1;
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return Math.exp(-w0 * t) * (1 + w0 * t);
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  // x = A·e^(r1 t) + B·e^(r2 t), A + B = 1, r1·A + r2·B = 0
  const a = -r2 / (r1 - r2);
  const b = r1 / (r1 - r2);
  return a * Math.exp(r1 * t) + b * Math.exp(r2 * t);
}

/** Progress 0 → 1 (may overshoot) of a spring at `frame`. */
function progressAt(frame: number, fps: number, config: SpringConfig): number {
  const p = 1 - displacement(frame / fps, config);
  return config.overshootClamping ? Math.min(1, p) : p;
}

function resolveConfig(config?: Partial<SpringConfig>): SpringConfig {
  const c = { ...DEFAULT_SPRING_CONFIG, ...config };
  if (!(c.mass > 0)) throw new RangeError('spring(): mass must be > 0');
  if (!(c.stiffness > 0)) throw new RangeError('spring(): stiffness must be > 0');
  if (!(c.damping >= 0)) throw new RangeError('spring(): damping must be >= 0');
  return c;
}

/**
 * Frames until the spring stays within `threshold` (fraction of the distance) of its target.
 * Scans forward until it has been settled for a full second, so a late wobble is not missed.
 */
export function measureSpring({ fps, config, threshold = 0.005 }: { fps: number; config?: Partial<SpringConfig>; threshold?: number }): number {
  if (!(fps > 0)) throw new RangeError('measureSpring(): fps must be > 0');
  const c = resolveConfig(config);
  let lastUnsettled = 0;
  const limit = fps * 600;
  for (let f = 0; f < limit; f++) {
    if (Math.abs(1 - progressAt(f, fps, c)) > threshold) lastUnsettled = f;
    else if (f - lastUnsettled > fps) break;
  }
  return lastUnsettled + 1;
}

export function spring({ frame, fps, config, from = 0, to = 1, delay = 0, durationInFrames, reverse = false, durationRestThreshold }: SpringOptions): number {
  if (!(fps > 0)) throw new RangeError('spring(): fps must be > 0');
  const c = resolveConfig(config);
  let f = frame - delay;
  if (durationInFrames !== undefined) {
    if (!(durationInFrames > 0)) throw new RangeError('spring(): durationInFrames must be > 0');
    const natural = measureSpring({ fps, config: c, threshold: durationRestThreshold });
    if (reverse) f = durationInFrames - f;
    f = (f / durationInFrames) * natural;
  } else if (reverse) {
    f = measureSpring({ fps, config: c, threshold: durationRestThreshold }) - f;
  }
  const p = f <= 0 ? 0 : progressAt(f, fps, c);
  return from + (to - from) * p;
}
