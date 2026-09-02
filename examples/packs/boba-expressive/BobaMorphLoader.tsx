import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { useUiScale } from '@neon/fx-kit';
import { type BlobShape, blobPath, blobRadii, easeExit, easeExpressiveDefault, easeExpressiveFast, lerpRadii } from './tokens.ts';

const SEQUENCE: BlobShape[] = ['oval', 'sunny', 'clover', 'flower', 'cookie'];

/**
 * The brand-mark loader: a blob that continuously morphs through a curated
 * shape sequence. Each 0.7-portion morph is synced with a +60° rotation snap
 * and a scale "breath" (1 → 0.9 → 1), while the whole mark drifts through a
 * slow 10s rotation.
 */
export const BobaMorphLoader: React.FC<{ color: string; size: number; stepSeconds: number }> = ({ color, size, stepSeconds }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const t = frame / fps;

  const step = Math.max(0.4, stepSeconds);
  const seg = Math.floor(t / step);
  const local = (t - seg * step) / step;
  const morphT = Math.min(local / 0.7, 1);
  const morphP = easeExpressiveDefault(morphT);

  const from = blobRadii(SEQUENCE[seg % SEQUENCE.length]!);
  const to = blobRadii(SEQUENCE[(seg + 1) % SEQUENCE.length]!);
  const path = blobPath(lerpRadii(from, to, morphP));

  const snapRotation = (seg + morphP) * 60;
  const driftRotation = (t / 10) * 360;
  const breath = 1 - 0.1 * Math.sin(Math.PI * morphT);
  const enter = interpolate(frame, [0, fps * 0.35], [0, 1], { easing: easeExpressiveFast, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = interpolate(frame, [durationInFrames - fps * 0.3, durationInFrames], [1, 0], { easing: easeExit, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: out }}>
      <div style={{ transform: `rotate(${driftRotation}deg)` }}>
        <svg
          width={size * s}
          height={size * s}
          viewBox="0 0 400 400"
          style={{ transform: `scale(${enter * breath}) rotate(${snapRotation}deg)` }}
        >
          <path d={path} fill={color} />
        </svg>
      </div>
    </AbsoluteFill>
  );
};
