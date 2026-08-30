import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { WatermarkProps } from '@neon/core';
import { MONO, useUiScale } from './shared.ts';

type Props = WatermarkProps;

export const Watermark: React.FC<Props> = ({ text, opacity, corner, color, fontSize }) => {
  const s = useUiScale();
  const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  return (
    <AbsoluteFill style={{ justifyContent: v === 'top' ? 'flex-start' : 'flex-end', alignItems: h === 'left' ? 'flex-start' : 'flex-end', padding: 40 * s }}>
      <div style={{ fontFamily: MONO, fontSize: fontSize * s, color, opacity, letterSpacing: 3, textTransform: 'uppercase' }}>{text}</div>
    </AbsoluteFill>
  );
};
