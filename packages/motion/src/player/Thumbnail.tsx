import React, { useLayoutEffect, useMemo } from 'react';
import { CompositionRoot, type Environment } from '../context.tsx';
import { CompositionErrorBoundary, useFit } from './Stage.tsx';
import { COMPOSITION_ATTR, ensureBaselineStyles } from '../baseline.ts';

export interface ThumbnailProps<P extends Record<string, unknown>> {
  component: React.ComponentType<P>;
  inputProps: P;
  durationInFrames: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  frameToDisplay: number;
  style?: React.CSSProperties;
  className?: string;
}

const noop = () => () => undefined;

/** A single still frame of a composition, fitted into its box. */
export function Thumbnail<P extends Record<string, unknown>>({
  component: Component,
  inputProps,
  durationInFrames,
  fps,
  compositionWidth,
  compositionHeight,
  frameToDisplay,
  style,
  className,
}: ThumbnailProps<P>): React.ReactElement {
  const { ref, scale, left, top } = useFit(compositionWidth, compositionHeight);
  useLayoutEffect(() => ensureBaselineStyles(), []);
  const environment = useMemo<Environment>(
    () => ({ mode: 'thumbnail', playing: false, muted: true, volume: 0, scale: scale || 1, frameUrl: null, media: { registerAudio: noop, setBuffering: () => undefined } }),
    [scale],
  );
  const config = useMemo(
    () => ({ id: 'thumbnail', width: compositionWidth, height: compositionHeight, fps, durationInFrames: Math.max(1, Math.floor(durationInFrames)) }),
    [compositionWidth, compositionHeight, fps, durationInFrames],
  );
  const frame = Math.min(config.durationInFrames - 1, Math.max(0, Math.round(frameToDisplay)));
  return (
    <div ref={ref} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {scale > 0 ? (
        <div {...{ [COMPOSITION_ATTR]: '' }} style={{ position: 'absolute', left, top, width: compositionWidth, height: compositionHeight, transform: `scale(${scale})`, transformOrigin: '0 0', overflow: 'hidden' }}>
          <CompositionErrorBoundary resetKey={inputProps}>
            <CompositionRoot frame={frame} config={config} environment={environment}>
              <Component {...inputProps} />
            </CompositionRoot>
          </CompositionErrorBoundary>
        </div>
      ) : null}
    </div>
  );
}
