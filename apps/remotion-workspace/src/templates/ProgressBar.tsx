import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ProgressBarProps } from '@neon/core';
import { glow, useUiScale } from './shared.ts';

type Props = ProgressBarProps;

export const ProgressBar: React.FC<Props> = ({ color, trackColor, height, position }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const pct = Math.min(100, (frame / Math.max(1, durationInFrames - 1)) * 100);
  return (
    <AbsoluteFill style={{ justifyContent: position === 'top' ? 'flex-start' : 'flex-end' }}>
      <div style={{ width: '100%', height: height * s, background: trackColor }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, boxShadow: glow(color, 0.6) }} />
      </div>
    </AbsoluteFill>
  );
};
