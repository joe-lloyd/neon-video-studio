import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { useUiScale } from '../../shared.ts';
import type { CLICK_PULSE } from './meta.ts';
import { dropShadow, useExit } from './tokens.ts';

const CLICK_AT = 0.08;
const DOUBLE_GAP = 0.2;
const RING_SECONDS = 0.6;
const RING_STAGGER = 0.1;

export const ClickPulse: React.FC<TemplateProps<typeof CLICK_PULSE>> = ({ x, y, color, size, double }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = useUiScale();
  const exit = useExit(0.2);
  const t = frame / fps;
  const clicks = double ? [CLICK_AT, CLICK_AT + DOUBLE_GAP] : [CLICK_AT];
  const cx = x * width;
  const cy = y * height;
  const dotR = 10 * s;
  const maxR = size * s;

  // The dot appears, dips on each click, and stays until the clip fades.
  const appear = interpolate(t, [0, CLICK_AT], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) });
  const dip = clicks.reduce((m, at) => Math.min(m, interpolate(t, [at, at + 0.05, at + 0.16], [1, 0.7, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })), 1);

  const rings = clicks.flatMap((at) => [at, at + RING_STAGGER]).map((start) => {
    const p = interpolate(t, [start, start + RING_SECONDS], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const eased = Easing.out(Easing.cubic)(p);
    return { r: dotR + (maxR - dotR) * eased, opacity: p > 0 && p < 1 ? 1 - p : 0, width: (5 - 3.5 * p) * s };
  });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible', filter: dropShadow(s) }}>
        <circle cx={cx} cy={cy} r={maxR * 0.55 * appear} fill={color} opacity={0.18 * appear} />
        {rings.map((ring, i) => (
          <circle key={i} cx={cx} cy={cy} r={ring.r} fill="none" stroke={color} strokeWidth={ring.width} opacity={ring.opacity} />
        ))}
        <circle cx={cx} cy={cy} r={dotR * appear * dip} fill={color} stroke="#FFFFFF" strokeWidth={3 * s} />
      </svg>
    </AbsoluteFill>
  );
};
