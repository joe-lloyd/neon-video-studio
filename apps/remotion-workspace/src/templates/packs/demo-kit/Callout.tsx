import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { SANS, clamp, useUiScale } from '../../shared.ts';
import type { CALLOUT } from './meta.ts';
import { dropShadow, shadow, textOn, useEnter, useExit } from './tokens.ts';

type Side = Exclude<TemplateProps<typeof CALLOUT>['side'], 'auto'>;
interface Point {
  x: number;
  y: number;
}
interface Placement {
  side: Side;
  /** Where the arrow leaves the bubble. */
  anchor: Point;
  /** Bubble centre on the axis across the arrow (y for left/right, x for top/bottom). */
  centre: number;
}

/**
 * Bubble placement for one side. Text is not measured, so the bubble size is an estimate; it only
 * decides whether a side fits and how far to nudge the bubble inside the frame. The arrow always
 * attaches to the real bubble edge because the bubble is positioned by that edge.
 */
function place(side: Side, target: Point, d: number, box: { w: number; h: number }, frame: { w: number; h: number }, margin: number): Placement & { fits: boolean } {
  const rise = (target.y > frame.h * 0.3 ? -1 : 1) * d * 0.45;
  const anchor =
    side === 'left' ? { x: target.x - d, y: target.y + rise }
    : side === 'right' ? { x: target.x + d, y: target.y + rise }
    : side === 'top' ? { x: target.x, y: target.y - d }
    : { x: target.x, y: target.y + d };
  if (side === 'left' || side === 'right') {
    const left = side === 'left' ? anchor.x - box.w : anchor.x;
    const fitsX = left >= margin && left + box.w <= frame.w - margin;
    const centre = clamp(anchor.y, margin + box.h / 2, frame.h - margin - box.h / 2);
    return { side, anchor: { x: anchor.x, y: centre }, centre, fits: fitsX };
  }
  const top = side === 'top' ? anchor.y - box.h : anchor.y;
  const fitsY = top >= margin && top + box.h <= frame.h - margin;
  const centre = clamp(anchor.x, margin + box.w / 2, frame.w - margin - box.w / 2);
  return { side, anchor: { x: clamp(anchor.x, centre - box.w / 2 + d * 0.2, centre + box.w / 2 - d * 0.2), y: anchor.y }, centre, fits: fitsY };
}

export const Callout: React.FC<TemplateProps<typeof CALLOUT>> = ({ text, x, y, side, color, size, distance }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = useUiScale();
  const exit = useExit(0.3);
  const bubbleIn = useEnter(0);
  const draw = interpolate(frame, [0.1 * fps, 0.45 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

  const fs = size * s;
  const padX = fs * 0.7;
  const padY = fs * 0.45;
  const maxText = fs * 16;
  const lines = text.split('\n');
  const lineWidths = lines.map((l) => Math.max(1, l.length) * fs * 0.56);
  const rows = lineWidths.reduce((n, w) => n + Math.ceil(w / maxText), 0);
  const box = { w: Math.min(maxText, Math.max(...lineWidths)) + padX * 2, h: rows * fs * 1.25 + padY * 2 };

  const target = { x: x * width, y: y * height };
  const d = distance * s;
  const margin = 24 * s;
  const frameSize = { w: width, h: height };
  const order: Side[] =
    side !== 'auto' ? [side]
    : [...(x >= 0.5 ? (['left', 'right'] as const) : (['right', 'left'] as const)), ...(y >= 0.5 ? (['top', 'bottom'] as const) : (['bottom', 'top'] as const))];
  const candidates = order.map((o) => place(o, target, d, box, frameSize, margin));
  const chosen = candidates.find((c) => c.fits) ?? candidates[0]!;

  // Curved arrow from the bubble edge to just short of the target, leaving what it points at visible.
  const gap = 6 * s;
  const start = chosen.anchor;
  const vx = target.x - start.x;
  const vy = target.y - start.y;
  const len = Math.hypot(vx, vy) || 1;
  const bow = (chosen.side === 'left' || chosen.side === 'bottom' ? 1 : -1) * len * 0.18;
  const ctrl = { x: (start.x + target.x) / 2 - (vy / len) * bow, y: (start.y + target.y) / 2 + (vx / len) * bow };
  const hx = target.x - ctrl.x;
  const hy = target.y - ctrl.y;
  const hl = Math.hypot(hx, hy) || 1;
  const dir = { x: hx / hl, y: hy / hl };
  const tip = { x: target.x - dir.x * gap, y: target.y - dir.y * gap };
  const headLen = 20 * s;
  const shaftEnd = { x: tip.x - dir.x * headLen * 0.7, y: tip.y - dir.y * headLen * 0.7 };
  const head = [
    tip,
    { x: tip.x - dir.x * headLen - dir.y * headLen * 0.55, y: tip.y - dir.y * headLen + dir.x * headLen * 0.55 },
    { x: tip.x - dir.x * headLen + dir.y * headLen * 0.55, y: tip.y - dir.y * headLen - dir.x * headLen * 0.55 },
  ];
  const headIn = interpolate(draw, [0.75, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const origin = { left: 'right center', right: 'left center', top: 'center bottom', bottom: 'center top' }[chosen.side];
  const bubblePos: React.CSSProperties =
    chosen.side === 'left' ? { right: width - chosen.anchor.x, top: chosen.centre, transform: 'translateY(-50%)' }
    : chosen.side === 'right' ? { left: chosen.anchor.x, top: chosen.centre, transform: 'translateY(-50%)' }
    : chosen.side === 'top' ? { bottom: height - chosen.anchor.y, left: chosen.centre, transform: 'translateX(-50%)' }
    : { top: chosen.anchor.y, left: chosen.centre, transform: 'translateX(-50%)' };

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible', filter: dropShadow(s) }}>
        <path
          d={`M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${shaftEnd.x} ${shaftEnd.y}`}
          fill="none"
          stroke={color}
          strokeWidth={5 * s}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - draw}
        />
        <polygon
          points={head.map((p) => `${p.x},${p.y}`).join(' ')}
          fill={color}
          stroke={color}
          strokeWidth={3 * s}
          strokeLinejoin="round"
          opacity={headIn}
          transform={`translate(${tip.x} ${tip.y}) scale(${0.5 + 0.5 * headIn}) translate(${-tip.x} ${-tip.y})`}
        />
      </svg>
      <div style={{ position: 'absolute', ...bubblePos }}>
        <div
          style={{
            maxWidth: maxText + padX * 2,
            padding: `${padY}px ${padX}px`,
            borderRadius: fs * 0.45,
            background: color,
            color: textOn(color),
            fontFamily: SANS,
            fontSize: fs,
            fontWeight: 650,
            lineHeight: 1.25,
            whiteSpace: 'pre-wrap',
            boxShadow: `${shadow(s)}, inset 0 0 0 ${1 * s}px rgba(255,255,255,0.22)`,
            opacity: bubbleIn,
            transform: `scale(${0.82 + 0.18 * bubbleIn})`,
            transformOrigin: origin,
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
