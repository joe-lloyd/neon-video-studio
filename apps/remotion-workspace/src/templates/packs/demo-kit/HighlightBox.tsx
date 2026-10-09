import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { SANS, useUiScale } from '../../shared.ts';
import type { HIGHLIGHT_BOX } from './meta.ts';
import { POP, shadow, textOn, tint, useEnter, useExit } from './tokens.ts';

const PULSE_SECONDS = 1.6;

export const HighlightBox: React.FC<TemplateProps<typeof HIGHLIGHT_BOX>> = ({ x, y, w, h, color, thickness, radius, padding, label, pulse }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = useUiScale();
  const enter = useEnter(0);
  const tagIn = useEnter(0.2, POP);
  const exit = useExit(0.3);

  const pad = padding * s;
  const stroke = thickness * s;
  const box = { left: x * width - pad, top: y * height - pad, width: w * width + pad * 2, height: h * height + pad * 2 };
  const r = radius * s + pad * 0.5;

  // A ring leaves the outline once per period, starting after the outline has settled.
  const since = frame / fps - 0.5;
  const phase = since > 0 ? (since % PULSE_SECONDS) / PULSE_SECONDS : -1;
  const ringOut = phase < 0 ? 0 : 1 - (1 - phase) ** 3;
  const ringOpacity = phase < 0 ? 0 : (1 - phase) * 0.55;
  const grow = ringOut * 16 * s;

  const tagFs = 22 * s;
  const tagH = tagFs * 1.7;
  const tagBelow = box.top - tagH < 8 * s;

  return (
    <AbsoluteFill style={{ opacity: exit * Math.min(1, enter * 1.5) }}>
      {pulse ? (
        <div
          style={{
            position: 'absolute',
            left: box.left - grow,
            top: box.top - grow,
            width: box.width + grow * 2,
            height: box.height + grow * 2,
            borderRadius: r + grow,
            border: `${Math.max(1, stroke * 0.75)}px solid ${color}`,
            opacity: ringOpacity,
            boxSizing: 'border-box',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          ...box,
          borderRadius: r,
          border: `${stroke}px solid ${color}`,
          background: tint(color, 6),
          boxSizing: 'border-box',
          boxShadow: `${shadow(s, 0.8)}, 0 0 0 ${1 * s}px rgba(0,0,0,0.28), inset 0 0 0 ${1 * s}px rgba(0,0,0,0.22)`,
          transform: `scale(${1.06 - 0.06 * enter})`,
        }}
      />
      {label ? (
        <div
          style={{
            position: 'absolute',
            left: box.left + r * 0.6,
            top: tagBelow ? box.top + box.height - stroke / 2 : box.top - tagH + stroke / 2,
            height: tagH,
            display: 'flex',
            alignItems: 'center',
            padding: `0 ${tagFs * 0.6}px`,
            borderRadius: tagFs * 0.4,
            background: color,
            color: textOn(color),
            fontFamily: SANS,
            fontSize: tagFs,
            fontWeight: 700,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            boxShadow: shadow(s, 0.7),
            opacity: Math.min(1, tagIn * 1.5),
            transform: `translateY(${(1 - tagIn) * (tagBelow ? -10 : 10) * s}px) scale(${0.9 + 0.1 * tagIn})`,
            transformOrigin: tagBelow ? 'left top' : 'left bottom',
          }}
        >
          {label}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
