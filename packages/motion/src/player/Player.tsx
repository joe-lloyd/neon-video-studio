import { resumePreviewAudio } from './audio-gain.ts';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CompositionRoot, type Environment, type MediaRegistry } from '../context.tsx';
import { CompositionErrorBoundary, useFit } from './Stage.tsx';
import { COMPOSITION_ATTR, ensureBaselineStyles } from '../baseline.ts';

export interface PlayerEventMap {
  frameupdate: { frame: number };
  seeked: { frame: number };
  play: Record<string, never>;
  pause: Record<string, never>;
  ended: Record<string, never>;
  mutechange: { isMuted: boolean };
  volumechange: { volume: number };
  error: { error: Error };
}

export type PlayerEventListener<K extends keyof PlayerEventMap> = (event: { detail: PlayerEventMap[K] }) => void;

export interface PlayerRef {
  play(): void;
  pause(): void;
  toggle(): void;
  seekTo(frame: number): void;
  getCurrentFrame(): number;
  isPlaying(): boolean;
  mute(): void;
  unmute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  requestFullscreen(): void;
  exitFullscreen(): void;
  getContainerNode(): HTMLDivElement | null;
  addEventListener<K extends keyof PlayerEventMap>(type: K, listener: PlayerEventListener<K>): void;
  removeEventListener<K extends keyof PlayerEventMap>(type: K, listener: PlayerEventListener<K>): void;
}

export interface PlayerProps<P extends Record<string, unknown>> {
  component: React.ComponentType<P>;
  inputProps: P;
  durationInFrames: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  style?: React.CSSProperties;
  className?: string;
  loop?: boolean;
  autoPlay?: boolean;
  initiallyMuted?: boolean;
  initialFrame?: number;
  /** Click on the video toggles playback (default true). */
  clickToPlay?: boolean;
  doubleClickToFullscreen?: boolean;
  /** Space toggles playback while the page has focus (default true). */
  spaceKeyToPlayOrPause?: boolean;
}

type AnyListener = (event: { detail: unknown }) => void;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function PlayerInner<P extends Record<string, unknown>>(
  {
    component: Component,
    inputProps,
    durationInFrames,
    fps,
    compositionWidth,
    compositionHeight,
    style,
    className,
    loop = false,
    autoPlay = false,
    initiallyMuted = false,
    initialFrame = 0,
    clickToPlay = true,
    doubleClickToFullscreen = false,
    spaceKeyToPlayOrPause = true,
  }: PlayerProps<P>,
  ref: React.ForwardedRef<PlayerRef>,
): React.ReactElement {
  if (!(durationInFrames >= 1)) throw new Error(`Player durationInFrames must be >= 1, got ${durationInFrames}`);
  if (!(fps > 0)) throw new Error(`Player fps must be > 0, got ${fps}`);
  const lastFrame = Math.max(0, Math.floor(durationInFrames) - 1);
  const [frame, setFrame] = useState(() => Math.min(lastFrame, Math.max(0, Math.round(initialFrame))));
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(initiallyMuted);
  const [volume, setVolumeState] = useState(1);
  const { ref: containerRef, scale, left, top } = useFit(compositionWidth, compositionHeight);

  // Mutable mirrors read by the clock and the imperative API.
  const frameRef = useRef(frame);
  const playingRef = useRef(false);
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  const listeners = useRef(new Map<string, Set<AnyListener>>());
  const buffering = useRef(new Set<string>());
  const clock = useRef<{ raf: number; anchorTime: number; anchorFrame: number; lastTick: number } | null>(null);
  const settings = useRef({ fps, lastFrame, loop });
  settings.current = { fps, lastFrame, loop };

  const emit = useCallback(<K extends keyof PlayerEventMap>(type: K, detail: PlayerEventMap[K]) => {
    for (const listener of listeners.current.get(type) ?? []) {
      try {
        listener({ detail });
      } catch (err) {
        console.error(`[player] ${type} listener failed`, err);
      }
    }
  }, []);

  const showFrame = useCallback(
    (f: number) => {
      if (f === frameRef.current) return;
      frameRef.current = f;
      setFrame(f);
      emit('frameupdate', { frame: f });
    },
    [emit],
  );

  const stopClock = useCallback(() => {
    if (clock.current) cancelAnimationFrame(clock.current.raf);
    clock.current = null;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const c = clock.current;
      if (!c) return;
      const { fps: rate, lastFrame: end, loop: looping } = settings.current;
      if (buffering.current.size > 0) {
        // Hold the picture while media buffers: slide the anchor forward by the stalled time.
        c.anchorTime += now - c.lastTick;
      }
      c.lastTick = now;
      let f = c.anchorFrame + Math.floor(((now - c.anchorTime) * rate) / 1000);
      if (f > end) {
        if (looping) {
          f = 0;
          c.anchorFrame = 0;
          c.anchorTime = now;
        } else {
          showFrame(end);
          stopClock();
          playingRef.current = false;
          setPlaying(false);
          emit('pause', {});
          emit('ended', {});
          return;
        }
      }
      showFrame(f);
      c.raf = requestAnimationFrame(tick);
    },
    [emit, showFrame, stopClock],
  );

  const play = useCallback(() => {
    resumePreviewAudio();
    if (playingRef.current) return;
    const { lastFrame: end } = settings.current;
    if (frameRef.current >= end && !settings.current.loop) showFrame(0);
    playingRef.current = true;
    setPlaying(true);
    const now = performance.now();
    clock.current = { raf: requestAnimationFrame(tick), anchorTime: now, anchorFrame: frameRef.current, lastTick: now };
    emit('play', {});
  }, [emit, showFrame, tick]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    stopClock();
    playingRef.current = false;
    setPlaying(false);
    emit('pause', {});
  }, [emit, stopClock]);

  const seekTo = useCallback(
    (target: number) => {
      const f = Math.min(settings.current.lastFrame, Math.max(0, Math.round(target)));
      showFrame(f);
      if (clock.current) {
        clock.current.anchorFrame = f;
        clock.current.anchorTime = performance.now();
      }
      emit('seeked', { frame: f });
    },
    [emit, showFrame],
  );

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play]);

  const setMutedBoth = useCallback(
    (m: boolean) => {
      if (mutedRef.current === m) return;
      mutedRef.current = m;
      setMuted(m);
      emit('mutechange', { isMuted: m });
    },
    [emit],
  );

  useImperativeHandle(
    ref,
    (): PlayerRef => ({
      play,
      pause,
      toggle,
      seekTo,
      getCurrentFrame: () => frameRef.current,
      isPlaying: () => playingRef.current,
      mute: () => setMutedBoth(true),
      unmute: () => setMutedBoth(false),
      isMuted: () => mutedRef.current,
      setVolume: (v: number) => {
        const next = Math.min(1, Math.max(0, v));
        volumeRef.current = next;
        setVolumeState(next);
        emit('volumechange', { volume: next });
      },
      getVolume: () => volumeRef.current,
      requestFullscreen: () => {
        containerRef.current?.requestFullscreen?.().catch(() => undefined);
      },
      exitFullscreen: () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
      },
      getContainerNode: () => containerRef.current,
      addEventListener: (type, listener) => {
        const set = listeners.current.get(type) ?? new Set<AnyListener>();
        set.add(listener as AnyListener);
        listeners.current.set(type, set);
      },
      removeEventListener: (type, listener) => {
        listeners.current.get(type)?.delete(listener as AnyListener);
      },
    }),
    [play, pause, toggle, seekTo, setMutedBoth, emit, containerRef],
  );

  // Clamp the playhead when the composition gets shorter.
  useEffect(() => {
    if (frameRef.current > lastFrame) seekTo(lastFrame);
  }, [lastFrame, seekTo]);

  useEffect(() => {
    ensureBaselineStyles();
    if (autoPlay) play();
    return stopClock;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  useEffect(() => {
    if (!spaceKeyToPlayOrPause) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [spaceKeyToPlayOrPause, toggle]);

  const media = useMemo<MediaRegistry>(
    () => ({
      registerAudio: () => () => undefined,
      setBuffering: (id, isBuffering) => {
        if (isBuffering) buffering.current.add(id);
        else buffering.current.delete(id);
      },
    }),
    [],
  );

  const environment = useMemo<Environment>(
    () => ({ mode: 'player', playing, muted, volume, scale: scale || 1, frameUrl: null, media }),
    [playing, muted, volume, scale, media],
  );
  const config = useMemo(
    () => ({ id: 'player', width: compositionWidth, height: compositionHeight, fps, durationInFrames: Math.floor(durationInFrames) }),
    [compositionWidth, compositionHeight, fps, durationInFrames],
  );
  // The element only changes with its props, so a new frame re-renders just the frame consumers.
  const element = useMemo(() => <Component {...inputProps} />, [Component, inputProps]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
      onClick={clickToPlay ? toggle : undefined}
      onDoubleClick={
        doubleClickToFullscreen
          ? () => {
              if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
              else containerRef.current?.requestFullscreen?.().catch(() => undefined);
            }
          : undefined
      }
    >
      {scale > 0 ? (
        <div
          {...{ [COMPOSITION_ATTR]: '' }}
          style={{
            position: 'absolute',
            left,
            top,
            width: compositionWidth,
            height: compositionHeight,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
            overflow: 'hidden',
          }}
        >
          <CompositionErrorBoundary resetKey={inputProps}>
            <CompositionRoot frame={frame} config={config} environment={environment}>
              {element}
            </CompositionRoot>
          </CompositionErrorBoundary>
        </div>
      ) : null}
    </div>
  );
}

/** Interactive preview of a composition: a clock, real media elements, and an imperative ref API. */
export const Player = forwardRef(PlayerInner) as <P extends Record<string, unknown>>(
  props: PlayerProps<P> & { ref?: React.Ref<PlayerRef> },
) => React.ReactElement;
