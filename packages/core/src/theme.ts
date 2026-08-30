/** Cyber Neon design tokens — single source of truth for UI, icons and Remotion templates. */
export const NEON = {
  magenta: '#FF007F',
  cyan: '#00F3FF',
  void: '#09090B',
  surface: '#0F0F13',
  surfaceRaised: '#15151B',
  border: 'rgba(255, 0, 127, 0.2)',
  borderStrong: 'rgba(255, 0, 127, 0.45)',
  text: '#F4F4F5',
  textMuted: '#A1A1AA',
  textFaint: '#52525B',
  success: '#39FF14',
  warning: '#FFB800',
  danger: '#FF3B3B',
  glowMagenta: 'rgba(255, 0, 127, 0.6)',
  glowCyan: 'rgba(0, 243, 255, 0.6)',
  fontMono: '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, monospace',
  fontSans: 'Inter, "SF Pro Text", system-ui, -apple-system, sans-serif',
} as const;

/** Track/clip colours per kind. */
export const CLIP_COLORS = {
  video: '#FF007F',
  audio: '#00F3FF',
  image: '#B45CFF',
  component: '#39FF14',
} as const;

/** Deterministic peer colour from a peer id (for cursors/playheads). */
export function peerColor(peerId: string): string {
  const palette = ['#FF007F', '#00F3FF', '#39FF14', '#FFB800', '#B45CFF', '#FF6B35', '#00D2A0', '#FF4FD8'];
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
  return palette[h % palette.length]!;
}
