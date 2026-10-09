import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { SANS, useUiScale } from '../../shared.ts';
import type { STEP_BADGE } from './meta.ts';
import { POP, SURFACE, SURFACE_BORDER, shadow, textOn, tint, useEnter, useExit } from './tokens.ts';

export const StepBadge: React.FC<TemplateProps<typeof STEP_BADGE>> = ({ step, title, subtitle, total, position, color, size }) => {
  const s = useUiScale();
  const card = useEnter(0);
  const disc = useEnter(0.1, POP);
  const copy = useEnter(0.18);
  const exit = useExit(0.3);

  const [v, h] = position.split('-');
  const fs = size * s;
  const discSize = fs * 1.85;
  const fromSide = h === 'left' ? -1 : h === 'right' ? 1 : 0;
  const fromEdge = v === 'top' ? -1 : 1;
  const slide = (1 - card) * 36 * s;
  const eyebrow = total > 0 ? `Step ${Math.round(step)} of ${Math.round(total)}` : '';

  return (
    <AbsoluteFill
      style={{
        justifyContent: v === 'top' ? 'flex-start' : 'flex-end',
        alignItems: h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center',
        padding: 56 * s,
        opacity: exit,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: fs * 0.55,
          padding: `${fs * 0.36}px ${fs * 0.9}px ${fs * 0.36}px ${fs * 0.36}px`,
          background: SURFACE,
          border: `${1 * s}px solid ${SURFACE_BORDER}`,
          borderRadius: fs * 0.6,
          boxShadow: shadow(s),
          fontFamily: SANS,
          opacity: Math.min(1, card * 1.4),
          transform: `translate(${fromSide * slide}px, ${fromSide === 0 ? fromEdge * slide : 0}px)`,
        }}
      >
        <div
          style={{
            width: discSize,
            height: discSize,
            flexShrink: 0,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: color,
            color: textOn(color),
            fontSize: fs * 0.95,
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            boxShadow: `inset 0 0 0 ${1.5 * s}px rgba(255,255,255,0.25), 0 0 0 ${4 * s}px ${tint(color, 22)}`,
            transform: `scale(${disc})`,
          }}
        >
          {Math.round(step)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: fs * 0.12, opacity: copy, transform: `translateX(${(1 - copy) * 14 * s}px)` }}>
          {eyebrow ? (
            <div style={{ color: `color-mix(in srgb, ${color} 55%, white)`, fontSize: fs * 0.42, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{eyebrow}</div>
          ) : null}
          <div style={{ color: '#FFFFFF', fontSize: fs, fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap' }}>{title}</div>
          {subtitle ? <div style={{ color: 'rgba(255,255,255,0.68)', fontSize: fs * 0.6, fontWeight: 500, lineHeight: 1.25, whiteSpace: 'nowrap' }}>{subtitle}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
