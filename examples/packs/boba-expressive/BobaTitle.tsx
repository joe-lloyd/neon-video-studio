import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { SANS, useUiScale } from '@neon/fx-kit';
import { BOBA, blobPath, blobRadii, easeEffects, easeExit, easeExpressiveDefault, easeExpressiveFast } from './tokens.ts';

/** Display title: words drift up into place one after another, tight 1.05 leading, matte and flat. */
export const BobaTitle: React.FC<{
  title: string;
  subtitle: string;
  textColor: string;
  accentColor: string;
  background: string;
  align: string;
  size: number;
}> = ({ title, subtitle, textColor, accentColor, background, align, size }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();
  const words = title.split(/\s+/).filter(Boolean);

  const out = interpolate(frame, [durationInFrames - fps * 0.3, durationInFrames], [1, 0], {
    easing: easeExit,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const wordProgress = (i: number) => {
    const start = fps * (0.15 + i * 0.06);
    return {
      y: interpolate(frame, [start, start + fps * 0.5], [1, 0], { easing: easeExpressiveDefault, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      o: interpolate(frame, [start, start + fps * 0.35], [0, 1], { easing: easeEffects, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    };
  };
  const subStart = fps * (0.3 + words.length * 0.06);
  const subO = interpolate(frame, [subStart, subStart + fps * 0.35], [0, 1], { easing: easeEffects, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const subY = interpolate(frame, [subStart, subStart + fps * 0.5], [20 * s, 0], { easing: easeExpressiveDefault, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const markScale = interpolate(frame, [subStart, subStart + fps * 0.35], [0, 1], { easing: easeExpressiveFast, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const bg = background === 'dark' ? BOBA.surfaceDark : background === 'light' ? BOBA.surfaceLight : 'transparent';
  const alignItems = align === 'center' ? 'center' : 'flex-start';
  return (
    <AbsoluteFill style={{ background: bg, justifyContent: 'center', alignItems, padding: 140 * s, opacity: out }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: alignItems, columnGap: size * 0.26 * s, maxWidth: '100%' }}>
        {words.map((word, i) => {
          const wp = wordProgress(i);
          return (
            <span
              key={i}
              style={{
                fontFamily: SANS,
                fontWeight: 500,
                fontSize: size * s,
                lineHeight: 1.05,
                letterSpacing: 0,
                color: textColor,
                opacity: wp.o,
                transform: `translateY(${wp.y * 46 * s}px)`,
                display: 'inline-block',
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
      {subtitle ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 * s, marginTop: size * 0.4 * s, opacity: subO, transform: `translateY(${subY}px)` }}>
          <svg width={size * 0.34 * s} height={size * 0.34 * s} viewBox="0 0 400 400" style={{ transform: `scale(${markScale})`, flexShrink: 0 }}>
            <path d={blobPath(blobRadii('clover'))} fill={accentColor} />
          </svg>
          <span style={{ fontFamily: SANS, fontWeight: 400, fontSize: size * 0.32 * s, lineHeight: 1.2, color: accentColor }}>{subtitle}</span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
