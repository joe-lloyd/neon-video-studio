import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CountdownProps } from '@neon/core';
import { MONO, glow, useUiScale } from './shared.ts';

type Props = CountdownProps;

export const Countdown: React.FC<Props> = ({ from, color, fontSize }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = useUiScale();
  const elapsed = frame / fps;
  const remaining = Math.max(0, Math.ceil(from - elapsed));
  const withinSecond = (frame % fps) / fps;
  const scale = interpolate(withinSecond, [0, 0.15, 1], [1.25, 1, 0.96], { extrapolateRight: 'clamp' });
  const ringProgress = 1 - (elapsed % 1);
  const size = fontSize * s * 1.6;

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'relative', width: size, height: size, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <svg width={size} height={size} viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
          <circle cx="50" cy="50" r="46" fill="none" stroke={`${color}33`} strokeWidth="3" />
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${ringProgress * 289} 289`}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />
        </svg>
        <div style={{ fontFamily: MONO, fontSize: fontSize * s, fontWeight: 800, color, textShadow: glow(color), transform: `scale(${scale})`, lineHeight: 1 }}>
          {remaining}
        </div>
      </div>
    </AbsoluteFill>
  );
};
