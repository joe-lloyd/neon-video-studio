import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { MONO, glow, useUiScale } from '../../shared.ts';

/** Props are validated against meta.ts — see docs/fx-packs.md. */
export const NeonBadge: React.FC<{ text: string; color: string; textColor: string; size: number; corner: string; pulse: boolean }> = ({
  text,
  color,
  textColor,
  size,
  corner,
  pulse,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = useUiScale();
  const enter = spring({ frame, fps, config: { damping: 12, stiffness: 200 } });
  const pulseScale = pulse ? 1 + 0.04 * Math.sin((frame / fps) * Math.PI * 2) : 1;
  const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  return (
    <AbsoluteFill style={{ justifyContent: v === 'top' ? 'flex-start' : 'flex-end', alignItems: h === 'left' ? 'flex-start' : 'flex-end', padding: 80 * s }}>
      <div
        style={{
          fontFamily: MONO,
          fontWeight: 800,
          fontSize: size * s,
          letterSpacing: 2,
          color: textColor,
          background: color,
          padding: `${size * 0.3 * s}px ${size * 0.7 * s}px`,
          borderRadius: 999,
          transform: `scale(${enter * pulseScale}) rotate(${(1 - enter) * 12}deg)`,
          boxShadow: glow(color),
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
