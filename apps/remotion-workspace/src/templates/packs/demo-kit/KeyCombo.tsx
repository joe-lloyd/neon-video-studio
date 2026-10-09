import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { SANS, useUiScale } from '../../shared.ts';
import type { KEY_COMBO } from './meta.ts';
import { comboLabels } from './keys.ts';
import { INK, POP, SURFACE, SURFACE_BORDER, shadow, tint, useEnter, useExit } from './tokens.ts';

export const KeyCombo: React.FC<TemplateProps<typeof KEY_COMBO>> = ({ combo, platform, label, x, y, size, color }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = useUiScale();
  const tray = useEnter(0);
  const exit = useExit(0.3);
  const chords = comboLabels(combo, platform);
  // Index of each chord's first key, so keys pop in one after another across chords.
  const firstKey = chords.map((_, c) => chords.slice(0, c).reduce((n, keys) => n + keys.length, 0));
  const keyCount = chords.reduce((n, keys) => n + keys.length, 0);

  const fs = size * s;
  const capH = fs * 2.05;
  const depth = fs * 0.16;
  const stagger = 0.06;
  // All keys go down together once the last one has landed, hold, then release.
  const pressAt = 0.3 + keyCount * stagger;
  const press = interpolate(frame / fps, [pressAt, pressAt + 0.07, pressAt + 0.4, pressAt + 0.52], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <div
        style={{
          position: 'absolute',
          left: x * width,
          top: y * height,
          transform: `translate(-50%, -50%) translateY(${(1 - tray) * 24 * s}px) scale(${0.94 + 0.06 * tray})`,
          opacity: Math.min(1, tray * 1.4),
          display: 'flex',
          alignItems: 'center',
          gap: fs * 0.4,
          padding: `${fs * 0.42}px ${fs * 0.5}px ${fs * 0.42 + depth * 0.5}px`,
          background: SURFACE,
          border: `${1 * s}px solid ${SURFACE_BORDER}`,
          borderRadius: fs * 0.75,
          boxShadow: shadow(s),
          fontFamily: SANS,
          whiteSpace: 'nowrap',
        }}
      >
        {chords.map((keys, c) => (
          <React.Fragment key={c}>
            {c > 0 ? <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: fs * 0.62, fontWeight: 500, padding: `0 ${fs * 0.1}px` }}>then</span> : null}
            {keys.map((k, i) => {
              const pop = spring({ frame: frame - (0.12 + ((firstKey[c] ?? 0) + i) * stagger) * fps, fps, config: POP });
              const glyph = [...k].length === 1 && !/[A-Za-z0-9]/.test(k);
              return (
                <React.Fragment key={i}>
                  {i > 0 && platform === 'pc' ? <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: fs * 0.8, fontWeight: 400 }}>+</span> : null}
                  <div
                    style={{
                      minWidth: capH,
                      height: capH,
                      boxSizing: 'border-box',
                      padding: `0 ${fs * 0.55}px`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: fs * 0.36,
                      background: 'linear-gradient(180deg, #FFFFFF 0%, #EEF0F4 100%)',
                      color: INK,
                      fontSize: glyph ? fs * 1.05 : fs,
                      fontWeight: 600,
                      boxShadow: [
                        `inset 0 ${-depth * (1 - press * 0.65)}px 0 #B8BEC9`,
                        `0 0 0 ${2 * s * press}px ${tint(color, 90)}`,
                        `0 ${(2 - press) * s}px ${3 * s}px rgba(0,0,0,0.4)`,
                      ].join(', '),
                      transform: `translateY(${press * depth * 0.6}px) scale(${0.6 + 0.4 * pop})`,
                      opacity: Math.min(1, pop * 1.6),
                    }}
                  >
                    {k}
                  </div>
                </React.Fragment>
              );
            })}
          </React.Fragment>
        ))}
        {label ? (
          <>
            <div style={{ width: 1.5 * s, alignSelf: 'stretch', margin: `${fs * 0.2}px ${fs * 0.15}px`, background: 'rgba(255,255,255,0.18)' }} />
            <span style={{ color: '#FFFFFF', fontSize: fs * 0.95, fontWeight: 600, paddingRight: fs * 0.2 }}>{label}</span>
          </>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
