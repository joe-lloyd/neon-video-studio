/**
 * @neon/fx-kit — the helpers FX pack components can rely on.
 *
 * Packs installed from outside the repo import ONLY `react`, `remotion`, `@neon/core` and this
 * module; the app provides all four at runtime (see docs/fx-packs.md). Keep this surface small
 * and additive — external packs compiled against an older kit must keep working.
 */
import { useVideoConfig } from 'remotion';

/** Templates are authored for 1080p; scale everything by the actual output height. */
export function useUiScale(): number {
  const { height } = useVideoConfig();
  return height / 1080;
}

export const MONO = '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';
export const SANS = 'Inter, "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif';

/** Triple-layer neon glow for `boxShadow` / `textShadow`. */
export function glow(color: string, strength = 1): string {
  return `0 0 ${12 * strength}px ${color}, 0 0 ${32 * strength}px ${color}, 0 0 ${64 * strength}px ${color}55`;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
