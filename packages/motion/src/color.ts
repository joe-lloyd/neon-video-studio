import { interpolate } from './interpolate.ts';

type Rgba = [number, number, number, number];

const NAMED: Record<string, string> = {
  transparent: '#0000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  olive: '#808000',
};

function hueToRgb(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

function num(part: string, scale: number): number {
  const s = part.trim();
  return s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s);
}

/** Parse a CSS colour (hex, rgb[a], hsl[a] or a common named colour) into 0–255 RGB + 0–1 alpha. */
export function parseColor(input: string): Rgba {
  const c = input.trim().toLowerCase();
  const named = NAMED[c];
  if (named) return parseColor(named);
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((ch) => ch + ch).join('');
    if ((hex.length === 6 || hex.length === 8) && /^[0-9a-f]+$/.test(hex)) {
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
    }
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(c);
  if (fn) {
    const parts = fn[2]!.replace(/\s*\/\s*/, ',').split(/[\s,]+/).filter(Boolean);
    const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
    if (fn[1]!.startsWith('rgb') && parts.length >= 3) {
      return [num(parts[0]!, 255), num(parts[1]!, 255), num(parts[2]!, 255), alpha];
    }
    if (fn[1]!.startsWith('hsl') && parts.length >= 3) {
      const h = (((parseFloat(parts[0]!) % 360) + 360) % 360) / 360;
      const s = num(parts[1]!, 1);
      const l = num(parts[2]!, 1);
      if (s === 0) return [l * 255, l * 255, l * 255, alpha];
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255, alpha];
    }
  }
  throw new Error(`Unsupported colour: ${input}`);
}

/** Interpolate between CSS colours; returns `rgba(r, g, b, a)`. Input outside the range is clamped. */
export function interpolateColors(input: number, inputRange: readonly number[], outputRange: readonly string[]): string {
  if (inputRange.length !== outputRange.length) throw new Error('interpolateColors(): ranges must have the same length');
  const colors = outputRange.map(parseColor);
  const channel = (i: number) =>
    interpolate(
      input,
      inputRange,
      colors.map((c) => c[i]!),
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
  const r = Math.round(channel(0));
  const g = Math.round(channel(1));
  const b = Math.round(channel(2));
  const a = Math.round(channel(3) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
