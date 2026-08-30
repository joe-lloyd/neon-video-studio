import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TitleCardProps } from '@neon/core';
import { MONO, SANS, glow, useUiScale } from './shared.ts';

type Props = TitleCardProps;

export const TitleCard: React.FC<Props> = ({ title, subtitle, background, accentColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 90 } });
  const line = interpolate(frame, [fps * 0.2, fps * 0.9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const sub = interpolate(frame, [fps * 0.5, fps * 1.1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = interpolate(frame, [durationInFrames - fps * 0.5, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background, justifyContent: 'center', alignItems: 'center', opacity: out }}>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 140 * s,
          fontWeight: 800,
          color: textColor,
          letterSpacing: -3 * s,
          transform: `scale(${0.85 + enter * 0.15})`,
          opacity: enter,
          textShadow: glow(accentColor, 0.6),
          textAlign: 'center',
          maxWidth: '85%',
        }}
      >
        {title}
      </div>
      <div style={{ width: `${line * 30}%`, height: 6 * s, background: accentColor, boxShadow: glow(accentColor), margin: `${28 * s}px 0`, borderRadius: 3 }} />
      {subtitle ? (
        <div style={{ fontFamily: MONO, fontSize: 40 * s, color: accentColor, opacity: sub, letterSpacing: 4, textTransform: 'uppercase' }}>{subtitle}</div>
      ) : null}
    </AbsoluteFill>
  );
};
