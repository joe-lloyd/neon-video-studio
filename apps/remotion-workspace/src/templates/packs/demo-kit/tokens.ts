/**
 * Demo Kit design tokens and motion helpers. Overlays sit on top of busy screen recordings, so
 * every surface is solid, every stroke has a dark shadow and text picks its own contrast.
 */
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/** Dark surface for cards and trays. */
export const SURFACE = 'rgba(17, 19, 24, 0.94)';
export const SURFACE_BORDER = 'rgba(255, 255, 255, 0.12)';
export const INK = '#111318';

/** Settles without a visible bounce: confident rather than playful. */
export const SETTLE = { damping: 20, stiffness: 170, mass: 0.9 };
/** A small overshoot for things that "pop" (badges, keycaps). */
export const POP = { damping: 13, stiffness: 190, mass: 0.8 };

export function shadow(s: number, strength = 1): string {
  return `0 ${2 * s}px ${6 * s}px rgba(0,0,0,${0.22 * strength}), 0 ${12 * s}px ${32 * s}px rgba(0,0,0,${0.32 * strength})`;
}

/** CSS drop-shadow filter for SVG strokes, which box-shadow cannot reach. */
export function dropShadow(s: number): string {
  return `drop-shadow(0 ${2 * s}px ${3 * s}px rgba(0,0,0,0.35)) drop-shadow(0 ${6 * s}px ${14 * s}px rgba(0,0,0,0.25))`;
}

/** `color` mixed with transparency, for tints of an arbitrary CSS colour. */
export function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** Near-black or white, whichever reads better on `color`. Unparseable colours get white. */
export function textOn(color: string): string {
  const rgb = parseRgb(color);
  if (!rgb) return '#FFFFFF';
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return luminance > 0.3 ? INK : '#FFFFFF';
}

function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((h) => h + h).join('') : hex;
    const at = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4) };
  }
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  return fn ? { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) } : null;
}

/** 0 → 1 spring that starts `delaySeconds` into the clip. */
export function useEnter(delaySeconds = 0, config = SETTLE): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delaySeconds * fps, fps, config });
}

/** 1 → 0 over the last `seconds` of the clip, whatever length the clip is trimmed to. */
export function useExit(seconds = 0.3): number {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return interpolate(frame, [durationInFrames - seconds * fps, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}
