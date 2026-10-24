import { setMediaGain, releaseMediaGain } from './player/audio-gain.ts';
import React, { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender } from './delay-render.ts';
import { useCurrentFrame, useEnvironment, useIsFrozen, useVideoConfig, type AudioFrameEntry } from './context.tsx';

function absoluteUrl(src: string): string {
  try {
    return new URL(src, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').href;
  } catch {
    return src;
  }
}

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

// ---- Img ----------------------------------------------------------------------------------

export interface ImgProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  /** Retries (with a cache-busting query) before an export fails on a broken image. */
  maxRetries?: number;
  /** Accepted for API compatibility. */
  pauseWhenLoading?: boolean;
}

/**
 * `<img>` that holds the renderer until it is loaded *and decoded*, so a frame never captures a
 * half-painted image. In the preview it is a plain image.
 */
export const Img = forwardRef<HTMLImageElement, ImgProps>(function Img({ src, maxRetries = 2, onLoad, onError, pauseWhenLoading: _p, ...rest }, ref) {
  const env = useEnvironment();
  const gate = env.mode !== 'player';
  const [attempt, setAttempt] = useState(0);
  const handleRef = useRef<number | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const effectiveSrc = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}neonRetry=${attempt}`;

  const release = useCallback(() => {
    if (handleRef.current !== null) {
      continueRender(handleRef.current);
      handleRef.current = null;
    }
  }, []);

  // Take the handle synchronously during commit so the renderer can't capture before the load starts.
  useLayoutEffect(() => {
    if (!gate) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) return;
    handleRef.current = delayRender(`Loading image ${src}`);
    return release;
  }, [gate, effectiveSrc, src, release]);

  const handleLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      onLoad?.(e);
      const img = e.currentTarget;
      if (!gate) return;
      // decode() resolves once the bitmap is ready to paint; some engines reject it for images
      // that are already decoded, which is fine.
      img.decode().catch(() => undefined).finally(release);
    },
    [gate, onLoad, release],
  );

  const handleError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      onError?.(e);
      if (!gate) return;
      if (attempt < maxRetries) {
        setTimeout(() => setAttempt((a) => a + 1), 250 * (attempt + 1));
        return;
      }
      release();
      cancelRender(new Error(`Could not load image ${src}`));
    },
    [gate, attempt, maxRetries, onError, release, src],
  );

  return (
    <img
      ref={(el) => {
        imgRef.current = el;
        assignRef(ref, el);
      }}
      src={effectiveSrc}
      onLoad={handleLoad}
      onError={handleError}
      {...rest}
    />
  );
});

// ---- shared media timing ---------------------------------------------------------------------

export type VolumeProp = number | ((frame: number) => number);

interface MediaTimingProps {
  src: string;
  /** Frames (at composition fps) to skip at the start of the source. */
  trimBefore?: number;
  /** Older name for `trimBefore`. */
  startFrom?: number;
  /** Source frame (composition fps) at which to stop. */
  trimAfter?: number;
  /** Older name for `trimAfter`. */
  endAt?: number;
  volume?: VolumeProp;
  playbackRate?: number;
  muted?: boolean;
}

interface MediaTiming {
  src: string;
  frame: number;
  fps: number;
  /** Seconds into the source for this frame. */
  mediaTime: number;
  /** False once the trimmed source has run out. */
  inRange: boolean;
  volume: number;
  playbackRate: number;
  frozen: boolean;
}

function useMediaTiming(props: MediaTimingProps): MediaTiming {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frozen = useIsFrozen();
  const trimBefore = props.trimBefore ?? props.startFrom ?? 0;
  const trimAfter = props.trimAfter ?? props.endAt;
  const playbackRate = props.playbackRate ?? 1;
  if (!(playbackRate > 0)) throw new Error(`playbackRate must be > 0, got ${playbackRate}`);
  const sourceFrame = trimBefore + frame * playbackRate;
  const raw = typeof props.volume === 'function' ? props.volume(frame) : props.volume ?? 1;
  return {
    src: absoluteUrl(props.src),
    frame,
    fps,
    mediaTime: sourceFrame / fps,
    inRange: frame >= 0 && (trimAfter === undefined || sourceFrame < trimAfter),
    volume: Number.isFinite(raw) ? Math.max(0, raw) : 0,
    playbackRate,
    frozen,
  };
}

/** Render mode: report this element's audio for the frame being captured. */
function useRenderAudio(timing: MediaTiming, audible: boolean): void {
  const env = useEnvironment();
  const entry = useRef<AudioFrameEntry | null>(null);
  entry.current =
    env.mode === 'render' && audible && timing.inRange && !timing.frozen && timing.volume > 0
      ? { src: timing.src, mediaTime: timing.mediaTime, volume: timing.volume, playbackRate: timing.playbackRate }
      : null;
  useLayoutEffect(() => env.media.registerAudio(() => entry.current), [env.media]);
}

/**
 * Player mode: keep a real media element in step with the composition clock. While playing the
 * element runs freely and is only re-seeked when it drifts; while paused it is seeked exactly.
 */
function usePlayerSync(el: React.RefObject<HTMLMediaElement | null>, timing: MediaTiming, opts: { muted: boolean; pauseWhenBuffering: boolean }): void {
  const env = useEnvironment();
  const id = useId();
  const active = env.mode === 'player' && env.playing && !timing.frozen && timing.inRange;

  useEffect(() => {
    const media = el.current;
    if (!media) return;
    const volume = Math.max(0, timing.volume * env.volume);
    media.muted = env.mode !== 'player' || env.muted || opts.muted || volume <= 0;
    setMediaGain(media, media.muted ? 0 : volume);
    if (media.playbackRate !== timing.playbackRate) media.playbackRate = timing.playbackRate;
    const drift = Math.abs(media.currentTime - timing.mediaTime);
    if (!active) {
      if (!media.paused) media.pause();
      if (drift > 0.5 / timing.fps) media.currentTime = timing.mediaTime;
      return;
    }
    if (drift > 0.2 + 0.5 / timing.fps) media.currentTime = timing.mediaTime;
    if (media.paused) {
      media.play().catch(() => {
        // Autoplay with sound refused (no user gesture yet): keep the picture moving silently.
        if (!media.muted) {
          media.muted = true;
          media.play().catch(() => undefined);
        }
      });
    }
  });

  useEffect(() => {
    const media = el.current;
    return media ? () => releaseMediaGain(media) : undefined;
  }, [el, timing.inRange, env.mode]);

  useEffect(() => {
    const media = el.current;
    if (!media || !opts.pauseWhenBuffering || env.mode !== 'player') return;
    const waiting = () => env.media.setBuffering(id, true);
    const ready = () => env.media.setBuffering(id, false);
    media.addEventListener('waiting', waiting);
    media.addEventListener('playing', ready);
    media.addEventListener('canplay', ready);
    media.addEventListener('seeked', ready);
    return () => {
      media.removeEventListener('waiting', waiting);
      media.removeEventListener('playing', ready);
      media.removeEventListener('canplay', ready);
      media.removeEventListener('seeked', ready);
      env.media.setBuffering(id, false);
    };
  }, [el, env.media, env.mode, id, opts.pauseWhenBuffering]);
}

// ---- Video ---------------------------------------------------------------------------------

export interface VideoProps extends MediaTimingProps, Omit<React.HTMLAttributes<HTMLElement>, 'onError'> {
  style?: React.CSSProperties;
  className?: string;
  /** Hold the preview clock while this video buffers. */
  pauseWhenBuffering?: boolean;
  /** Export frames with an alpha channel (PNG instead of BMP from the frame server). */
  transparent?: boolean;
  /** Accepted for API compatibility. */
  toneMapped?: boolean;
  onError?: (error: Error) => void;
}

/**
 * A video layer. In the preview it is a `<video>` synced to the clock; in an export every frame is
 * an exact decoded still from the frame server, so seeking never shows the wrong frame.
 */
export function Video({ style, className, pauseWhenBuffering = false, transparent = false, toneMapped: _t, onError, ...props }: VideoProps): React.ReactElement | null {
  const env = useEnvironment();
  const timing = useMediaTiming(props);
  const ref = useRef<HTMLVideoElement | null>(null);
  useRenderAudio(timing, !props.muted);
  usePlayerSync(ref, timing, { muted: Boolean(props.muted), pauseWhenBuffering });
  const { src: _src, trimBefore: _a, startFrom: _b, trimAfter: _c, endAt: _d, volume: _v, playbackRate: _r, muted: _m, ...domProps } = props;

  if (!timing.inRange) return null;
  if (env.mode === 'render') {
    if (!env.frameUrl) throw new Error('<Video> in render mode needs a frame server');
    const url = env.frameUrl(timing.src, timing.mediaTime, { transparent });
    return <Img {...(domProps as React.ImgHTMLAttributes<HTMLImageElement>)} src={url} className={className} style={{ objectFit: 'contain', ...style }} alt="" />;
  }
  return (
    <video
      {...(domProps as React.VideoHTMLAttributes<HTMLVideoElement>)}
      ref={ref}
      crossOrigin="anonymous"
      src={timing.src}
      className={className}
      style={style}
      playsInline
      preload="auto"
      onError={() => onError?.(new Error(`Could not load video ${timing.src}`))}
    />
  );
}

/** Same as `<Video>` (the export path always extracts exact frames off-thread). */
export const OffthreadVideo = Video;

// ---- Audio ---------------------------------------------------------------------------------

export interface AudioProps extends MediaTimingProps {
  pauseWhenBuffering?: boolean;
  onError?: (error: Error) => void;
}

/** An audio layer: an `<audio>` element in the preview, mixed offline by FFmpeg in an export. */
export function Audio({ pauseWhenBuffering = false, onError, ...props }: AudioProps): React.ReactElement | null {
  const env = useEnvironment();
  const timing = useMediaTiming(props);
  const ref = useRef<HTMLAudioElement | null>(null);
  useRenderAudio(timing, !props.muted);
  usePlayerSync(ref, timing, { muted: Boolean(props.muted), pauseWhenBuffering });
  if (!timing.inRange || env.mode !== 'player') return null;
  return <audio ref={ref} crossOrigin="anonymous" src={timing.src} preload="auto" onError={() => onError?.(new Error(`Could not load audio ${timing.src}`))} />;
}
