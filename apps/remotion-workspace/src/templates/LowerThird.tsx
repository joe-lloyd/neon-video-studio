import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { LowerThirdProps } from '@neon/core';
import { MONO, SANS, glow, useUiScale } from './shared.ts';

type Props = LowerThirdProps;

export const LowerThird: React.FC<Props> = ({ title, subtitle, accentColor, textColor, side }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 140 } });
  const exit = interpolate(frame, [durationInFrames - fps * 0.5, durationInFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const offset = (1 - enter) * 400 * s + exit * 400 * s;
  const dir = side === 'left' ? -1 : 1;

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: side === 'left' ? 'flex-start' : 'flex-end', padding: `${120 * s}px ${96 * s}px` }}>
      <div
        style={{
          display: 'flex',
          flexDirection: side === 'left' ? 'row' : 'row-reverse',
          alignItems: 'stretch',
          transform: `translateX(${dir * offset}px)`,
          opacity: 1 - exit,
          background: 'rgba(9, 9, 11, 0.78)',
          backdropFilter: 'blur(12px)',
          border: `1px solid ${accentColor}55`,
          boxShadow: glow(accentColor, 0.5),
          borderRadius: 8 * s,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: 10 * s, background: accentColor, boxShadow: glow(accentColor) }} />
        <div style={{ padding: `${20 * s}px ${36 * s}px`, textAlign: side === 'left' ? 'left' : 'right' }}>
          <div style={{ fontFamily: SANS, fontSize: 52 * s, fontWeight: 700, color: textColor, letterSpacing: -0.5 }}>{title}</div>
          {subtitle ? (
            <div style={{ fontFamily: MONO, fontSize: 26 * s, color: accentColor, marginTop: 6 * s, textTransform: 'uppercase', letterSpacing: 2 }}>{subtitle}</div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
