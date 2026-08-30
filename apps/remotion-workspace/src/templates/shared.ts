import { useVideoConfig } from 'remotion';

/** Templates are authored for 1080p; scale everything by the actual output height. */
export function useUiScale(): number {
  const { height } = useVideoConfig();
  return height / 1080;
}

export const MONO = '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';
export const SANS = 'Inter, "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif';

export function glow(color: string, strength = 1): string {
  return `0 0 ${12 * strength}px ${color}, 0 0 ${32 * strength}px ${color}, 0 0 ${64 * strength}px ${color}55`;
}
