import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { useUiScale } from '../../shared.ts';
import { type BlobShape, blobPath, blobRadii, easeExit, easeExpressiveFast } from './tokens.ts';

/**
 * A single organic blob shape — springs in with an overshoot, optionally
 * rotates slowly and "breathes". Move/scale it on the canvas like any clip.
 */
export const BobaBlob: React.FC<{ shape: string; color: string; size: number; spin: boolean; breath: boolean }> = ({
  shape,
  color,
  size,
  spin,
  breath,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const t = frame / fps;

  const enter = interpolate(frame, [0, fps * 0.5], [0, 1], { easing: easeExpressiveFast, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = interpolate(frame, [durationInFrames - fps * 0.3, durationInFrames], [1, 0], { easing: easeExit, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const breathScale = breath ? 1 + 0.03 * Math.sin((t / 3) * Math.PI * 2) : 1;
  const rotation = spin ? (t / 10) * 360 : 0;

  const path = blobPath(blobRadii(shape as BlobShape));
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: out }}>
      <svg
        width={size * s}
        height={size * s}
        viewBox="0 0 400 400"
        style={{ transform: `scale(${enter * breathScale}) rotate(${rotation}deg)` }}
      >
        <path d={path} fill={color} />
      </svg>
    </AbsoluteFill>
  );
};
