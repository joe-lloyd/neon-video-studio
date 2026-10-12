import type { EasingFunction } from './easing.ts';

/** What happens outside the input range: keep the slope, hold the edge value, pass the input through, or repeat. */
export type ExtrapolateType = 'extend' | 'clamp' | 'identity' | 'wrap';

export interface InterpolateOptions {
  easing?: EasingFunction;
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
}

function checkRanges(input: readonly number[], output: readonly number[]): void {
  if (input.length !== output.length) throw new Error(`interpolate(): inputRange (${input.length}) and outputRange (${output.length}) must have the same length`);
  if (input.length < 2) throw new Error('interpolate(): ranges need at least 2 values');
  for (let i = 0; i < input.length; i++) {
    const v = input[i]!;
    if (!Number.isFinite(v) && !(i === 0 && v === -Infinity) && !(i === input.length - 1 && v === Infinity)) {
      throw new Error(`interpolate(): inputRange contains a non-finite value (${v})`);
    }
    if (!Number.isFinite(output[i]!)) throw new Error(`interpolate(): outputRange contains a non-finite value (${output[i]})`);
    if (i > 0 && !(v > input[i - 1]!)) throw new Error(`interpolate(): inputRange must be strictly increasing, got [${input.join(', ')}]`);
  }
}

function segment(x: number, inMin: number, inMax: number, outMin: number, outMax: number, opts: InterpolateOptions): number {
  const left = opts.extrapolateLeft ?? 'extend';
  const right = opts.extrapolateRight ?? 'extend';
  let input = x;
  if (input < inMin) {
    if (left === 'identity') return input;
    if (left === 'clamp') input = inMin;
    else if (left === 'wrap') input = inMin + ((((input - inMin) % (inMax - inMin)) + (inMax - inMin)) % (inMax - inMin));
  }
  if (input > inMax) {
    if (right === 'identity') return input;
    if (right === 'clamp') input = inMax;
    else if (right === 'wrap') input = inMin + ((input - inMin) % (inMax - inMin));
  }
  if (outMin === outMax) return outMin;
  let t = inMax === inMin ? 0 : (input - inMin) / (inMax - inMin);
  // Easing only applies inside the range; 'extend' continues the eased curve's endpoints linearly.
  if (opts.easing && t >= 0 && t <= 1) t = opts.easing(t);
  return outMin + t * (outMax - outMin);
}

/**
 * Map `input` from `inputRange` to `outputRange` piecewise-linearly (optionally eased per segment).
 *
 *   interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' })
 */
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly number[], options: InterpolateOptions = {}): number {
  if (typeof input !== 'number' || Number.isNaN(input)) throw new TypeError(`interpolate(): input must be a number, got ${String(input)}`);
  checkRanges(inputRange, outputRange);
  let i = 1;
  for (; i < inputRange.length - 1; i++) if (inputRange[i]! >= input) break;
  i -= 1;
  return segment(input, inputRange[i]!, inputRange[i + 1]!, outputRange[i]!, outputRange[i + 1]!, options);
}
