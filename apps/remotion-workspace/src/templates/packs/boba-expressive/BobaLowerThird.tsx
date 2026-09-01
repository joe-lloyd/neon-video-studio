import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { SANS, useUiScale } from '../../shared.ts';
import { BOBA, RADIUS_ACTIVE, RADIUS_PILL, blobPath, blobRadii, easeEffects, easeExit, easeExpressiveFast, easeExpressiveSlow } from './tokens.ts';

/**
 * Frosted pill lower third: reveals center-out behind 32px backdrop blur,
 * text staggers in, and on exit the pill "squares up" to 12px as it fades.
 */
export const BobaLowerThird: React.FC<{
  title: string;
  subtitle: string;
  accentColor: string;
  theme: string;
  side: string;
}> = ({ title, subtitle, accentColor, theme, side }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = useUiScale();

  const reveal = interpolate(frame, [0, fps * 0.6], [50, 0], { easing: easeExpressiveSlow, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const exitStart = durationInFrames - fps * 0.35;
  const out = interpolate(frame, [exitStart, durationInFrames], [1, 0], { easing: easeExit, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const radius = interpolate(frame, [exitStart, durationInFrames], [RADIUS_PILL, RADIUS_ACTIVE], {
    easing: easeExpressiveFast,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const textAt = (delaySeconds: number) => {
    const start = fps * delaySeconds;
    return {
      o: interpolate(frame, [start, start + fps * 0.35], [0, 1], { easing: easeEffects, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      y: interpolate(frame, [start, start + fps * 0.5], [-20 * s, 0], { easing: easeExpressiveSlow, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    };
  };
  const titleAnim = textAt(0.15);
  const subAnim = textAt(0.25);
  const markScale = interpolate(frame, [fps * 0.2, fps * 0.55], [0, 1], { easing: easeExpressiveFast, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const dark = theme !== 'light';
  const surface = dark ? 'rgba(13, 13, 13, 0.8)' : 'rgba(249, 249, 249, 0.85)';
  const ink = dark ? '#ffffff' : BOBA.ink;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: side === 'right' ? 'flex-end' : 'flex-start', padding: 90 * s }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 22 * s,
          background: surface,
          backdropFilter: `blur(${32 * s}px)`,
          WebkitBackdropFilter: `blur(${32 * s}px)`,
          borderRadius: radius * s,
          padding: `${26 * s}px ${46 * s}px`,
          clipPath: `inset(0% ${reveal}% 0% ${reveal}% round ${RADIUS_PILL}px)`,
          opacity: out,
        }}
      >
        <svg width={52 * s} height={52 * s} viewBox="0 0 400 400" style={{ transform: `scale(${markScale})`, flexShrink: 0 }}>
          <path d={blobPath(blobRadii('sunny'))} fill={accentColor} />
        </svg>
        <div>
          <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 44 * s, lineHeight: 1.2, letterSpacing: 0, color: ink, opacity: titleAnim.o, transform: `translateY(${titleAnim.y}px)` }}>
            {title}
          </div>
          {subtitle ? (
            <div style={{ fontFamily: SANS, fontWeight: 400, fontSize: 27 * s, lineHeight: 1.3, color: accentColor, marginTop: 4 * s, opacity: subAnim.o, transform: `translateY(${subAnim.y}px)` }}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
