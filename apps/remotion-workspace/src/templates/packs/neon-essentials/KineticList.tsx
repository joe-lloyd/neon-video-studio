import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { MONO, SANS, glow, useUiScale } from '../../shared.ts';

export const KineticList: React.FC<{ title: string; items: string; accentColor: string; textColor: string; align: string; staggerSeconds: number }> = ({
  title,
  items,
  accentColor,
  textColor,
  align,
  staggerSeconds,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const lines = items.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = interpolate(frame, [durationInFrames - fps * 0.4, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: align === 'center' ? 'center' : 'flex-start', padding: 120 * s, opacity: out }}>
      <div style={{ fontFamily: MONO, fontSize: 30 * s, color: accentColor, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 24 * s, textShadow: glow(accentColor, 0.5) }}>
        {title}
      </div>
      {lines.map((line, i) => {
        const start = fps * 0.3 + i * fps * staggerSeconds;
        const p = spring({ frame: frame - start, fps, config: { damping: 16, stiffness: 130 } });
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 18 * s, margin: `${10 * s}px 0`, opacity: p, transform: `translateX(${(1 - p) * 80 * s}px)` }}>
            <div style={{ width: 14 * s, height: 14 * s, borderRadius: 3, background: accentColor, boxShadow: glow(accentColor, 0.7) }} />
            <div style={{ fontFamily: SANS, fontSize: 52 * s, fontWeight: 650, color: textColor, textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>{line}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
