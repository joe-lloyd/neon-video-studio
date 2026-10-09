import React, { useId } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { TemplateProps } from '@neon/core';
import { useUiScale } from '../../shared.ts';
import type { SPOTLIGHT } from './meta.ts';
import { useEnter, useExit } from './tokens.ts';

/** Rounded rectangle as a path, so it can be cut out of the full-frame dim with evenodd. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${x + rr} ${y}`,
    `H ${x + w - rr} A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr}`,
    `V ${y + h - rr} A ${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}`,
    `H ${x + rr} A ${rr} ${rr} 0 0 1 ${x} ${y + h - rr}`,
    `V ${y + rr} A ${rr} ${rr} 0 0 1 ${x + rr} ${y}`,
    'Z',
  ].join(' ');
}

export const Spotlight: React.FC<TemplateProps<typeof SPOTLIGHT>> = ({ x, y, w, h, radius, dim, feather }) => {
  const { width, height } = useVideoConfig();
  const s = useUiScale();
  const filterId = `spotlight-${useId().replace(/:/g, '')}`;
  const enter = useEnter(0);
  const exit = useExit(0.35);

  // The hole starts wide and closes onto the target while the dim fades up: an iris. It sits a
  // little outside the given bounds so the feathered edge never darkens the element itself.
  const blur = feather * s;
  const grow = (1 - enter) * Math.max(width, height) * 0.25 + blur * 1.5 + 4 * s;
  const hx = x * width - grow;
  const hy = y * height - grow;
  const hw = w * width + grow * 2;
  const hh = h * height + grow * 2;
  // Extend the dim past the frame so the blur never lightens the frame edges.
  const bleed = blur * 3 + 4;
  const outer = `M ${-bleed} ${-bleed} H ${width + bleed} V ${height + bleed} H ${-bleed} Z`;

  return (
    <AbsoluteFill>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <filter id={filterId} x={-bleed} y={-bleed} width={width + bleed * 2} height={height + bleed * 2} filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation={blur} />
          </filter>
        </defs>
        <path
          d={`${outer} ${roundedRect(hx, hy, hw, hh, radius * s + grow * 0.6)}`}
          fillRule="evenodd"
          fill="#05060A"
          opacity={dim * Math.min(1, enter * 1.4) * exit}
          filter={blur > 0 ? `url(#${filterId})` : undefined}
        />
      </svg>
    </AbsoluteFill>
  );
};
