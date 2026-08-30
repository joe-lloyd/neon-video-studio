import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TextOverlayProps } from '@neon/core';
import { glow, useUiScale } from './shared.ts';

type Props = TextOverlayProps;

export const TextOverlay: React.FC<Props> = ({ text, fontSize, color, glowColor, position, align, animation, fontFamily }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();

  const fadeOutStart = Math.max(0, durationInFrames - Math.round(fps * 0.4));
  const outro = interpolate(frame, [fadeOutStart, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  let opacity = 1;
  let translateY = 0;
  let visibleText = text;
  if (animation === 'fade') {
    opacity = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: 'clamp' });
  } else if (animation === 'slide-up') {
    const progress = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
    opacity = progress;
    translateY = (1 - progress) * 60 * s;
  } else if (animation === 'typewriter') {
    const chars = Math.floor(interpolate(frame, [0, Math.max(1, text.length * 2)], [0, text.length], { extrapolateRight: 'clamp' }));
    visibleText = text.slice(0, chars);
  }

  const justify = position === 'top' ? 'flex-start' : position === 'bottom' ? 'flex-end' : 'center';
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center', padding: 96 * s }}>
      <div
        style={{
          fontFamily,
          fontSize: fontSize * s,
          fontWeight: 700,
          color,
          textAlign: align,
          textShadow: glow(glowColor),
          opacity: opacity * outro,
          transform: `translateY(${translateY}px)`,
          lineHeight: 1.15,
          whiteSpace: 'pre-wrap',
          maxWidth: '90%',
        }}
      >
        {visibleText}
        {animation === 'typewriter' && visibleText.length < text.length ? <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▍</span> : null}
      </div>
    </AbsoluteFill>
  );
};
