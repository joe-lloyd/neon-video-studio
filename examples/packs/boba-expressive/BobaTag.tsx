import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { SANS, useUiScale } from '@neon/fx-kit';
import { RADIUS_ACTIVE, RADIUS_PILL, easeExit, easeExpressiveFast } from './tokens.ts';

/**
 * Matte pill tag: enters with the signature circle-to-pill clip reveal
 * (0.35s, expressive-fast), sits flat — no pulse, no glow — then squares
 * to 12px and fades on exit.
 */
export const BobaTag: React.FC<{ text: string; color: string; textColor: string; size: number; corner: string }> = ({
  text,
  color,
  textColor,
  size,
  corner,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();

  const inset = interpolate(frame, [0, fps * 0.35], [42, 0], { easing: easeExpressiveFast, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeIn = interpolate(frame, [0, fps * 0.12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const exitStart = durationInFrames - fps * 0.3;
  const out = interpolate(frame, [exitStart, durationInFrames], [1, 0], { easing: easeExit, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const radius = interpolate(frame, [exitStart, durationInFrames], [RADIUS_PILL, RADIUS_ACTIVE], {
    easing: easeExpressiveFast,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  return (
    <AbsoluteFill style={{ justifyContent: v === 'top' ? 'flex-start' : 'flex-end', alignItems: h === 'left' ? 'flex-start' : 'flex-end', padding: 80 * s }}>
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 500,
          fontSize: size * s,
          lineHeight: 1,
          letterSpacing: 0,
          color: textColor,
          background: color,
          padding: `${size * 0.45 * s}px ${size * 0.8 * s}px`,
          borderRadius: radius * s,
          clipPath: `inset(0% ${inset}% 0% ${inset}% round ${RADIUS_PILL}px)`,
          opacity: fadeIn * out,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
