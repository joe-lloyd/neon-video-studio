import React, { createContext, useContext, useMemo } from 'react';

/**
 * Where a composition is being drawn:
 *  - `player`    the interactive preview (real <video>/<audio> elements, synced to a clock)
 *  - `render`    the headless exporter (exact video frames as images, audio mixed offline)
 *  - `thumbnail` a single still in the preview UI
 */
export type RenderMode = 'player' | 'render' | 'thumbnail';

export interface VideoConfig {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** The composition length — or, inside a `<Sequence>` with a duration, that sequence's length. */
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
  props: Record<string, unknown>;
}

/** One audible media element on one rendered frame (render mode). */
export interface AudioFrameEntry {
  src: string;
  /** Position in the source, seconds. */
  mediaTime: number;
  /** Linear gain, 0 = silent. */
  volume: number;
  playbackRate: number;
}

export interface MediaRegistry {
  /** Render mode: audible media register a getter that reports their state for the current frame. */
  registerAudio(getEntry: () => AudioFrameEntry | null): () => void;
  /** Player mode: media that are still loading hold the clock when `pauseWhenBuffering` is set. */
  setBuffering(id: string, buffering: boolean): void;
}

export interface Environment {
  mode: RenderMode;
  playing: boolean;
  muted: boolean;
  /** Player master volume, 0–1. */
  volume: number;
  /** Display px per composition px (for `useCurrentScale()`). */
  scale: number;
  /** Render mode: URL of an exact decoded frame of `src` at `time` seconds. */
  frameUrl: ((src: string, time: number, opts: { transparent: boolean }) => string) | null;
  media: MediaRegistry;
}

const noopRegistry: MediaRegistry = { registerAudio: () => () => undefined, setBuffering: () => undefined };

export const EnvironmentContext = createContext<Environment>({
  mode: 'player',
  playing: false,
  muted: true,
  volume: 1,
  scale: 1,
  frameUrl: null,
  media: noopRegistry,
});

/** Absolute frame of the root composition. */
export const RootFrameContext = createContext<number | null>(null);
export const CompositionContext = createContext<Omit<VideoConfig, 'durationInFrames'> & { durationInFrames: number } | null>(null);

export interface SequenceState {
  /** Absolute frame at which this sequence's frame 0 occurs. */
  offset: number;
  durationInFrames: number;
  /** Set inside <Freeze>: children see this absolute frame forever. */
  frozenAt: number | null;
}

export const SequenceContext = createContext<SequenceState | null>(null);

export function useEnvironment(): Environment {
  return useContext(EnvironmentContext);
}

/** The absolute root frame as seen from here (a <Freeze> pins it). */
export function useAbsoluteFrame(): number {
  const root = useContext(RootFrameContext);
  const seq = useContext(SequenceContext);
  if (root === null) throw new Error('useCurrentFrame() can only be used inside a composition (Player, Thumbnail or the renderer)');
  return seq?.frozenAt ?? root;
}

/** Frame number relative to the nearest enclosing `<Sequence>` (or the composition start). */
export function useCurrentFrame(): number {
  const abs = useAbsoluteFrame();
  const seq = useContext(SequenceContext);
  return abs - (seq?.offset ?? 0);
}

export function useVideoConfig(): VideoConfig {
  const comp = useContext(CompositionContext);
  const seq = useContext(SequenceContext);
  if (!comp) throw new Error('useVideoConfig() can only be used inside a composition (Player, Thumbnail or the renderer)');
  return useMemo(
    () => (seq && Number.isFinite(seq.durationInFrames) ? { ...comp, durationInFrames: seq.durationInFrames } : comp),
    [comp, seq],
  );
}

/**
 * Display scale of the composition (preview zoom); 1 when rendering. Never throws — outside a
 * composition it reports 1 — so the compatibility option `dontThrowIfOutsideOfRemotion` is accepted
 * and needs no handling.
 */
export function useCurrentScale(_options?: { dontThrowIfOutsideOfRemotion?: boolean }): number {
  return useContext(EnvironmentContext).scale;
}

/** True inside a <Freeze>. */
export function useIsFrozen(): boolean {
  return useContext(SequenceContext)?.frozenAt != null;
}

export interface CompositionRootProps {
  frame: number;
  config: Omit<VideoConfig, 'defaultProps' | 'props'> & Partial<Pick<VideoConfig, 'defaultProps' | 'props'>>;
  environment: Environment;
  children: React.ReactNode;
}

/** Provides the frame, composition config and environment to a component tree. */
export function CompositionRoot({ frame, config, environment, children }: CompositionRootProps): React.ReactElement {
  const comp = useMemo(
    () => ({ defaultProps: {}, props: {}, ...config }),
    [config.id, config.width, config.height, config.fps, config.durationInFrames, config.defaultProps, config.props],
  );
  return (
    <EnvironmentContext.Provider value={environment}>
      <CompositionContext.Provider value={comp}>
        <RootFrameContext.Provider value={frame}>
          <SequenceContext.Provider value={null}>{children}</SequenceContext.Provider>
        </RootFrameContext.Provider>
      </CompositionContext.Provider>
    </EnvironmentContext.Provider>
  );
}
