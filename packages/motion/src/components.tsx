import React, { forwardRef, useContext, useMemo } from 'react';
import { CompositionContext, SequenceContext, useAbsoluteFrame, useCurrentFrame, useEnvironment, type SequenceState } from './context.tsx';

const FILL: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
};

/** A full-size, absolutely positioned flex column — the basic layer of a composition. */
export const AbsoluteFill = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function AbsoluteFill({ style, ...rest }, ref) {
  const merged = useMemo(() => (style ? { ...FILL, ...style } : FILL), [style]);
  return <div ref={ref} style={merged} {...rest} />;
});

export interface SequenceProps {
  /** Frame (relative to the parent) at which this sequence starts. May be negative to trim its start. */
  from?: number;
  durationInFrames?: number;
  name?: string;
  /** `absolute-fill` (default) wraps children in an AbsoluteFill; `none` renders them as-is. */
  layout?: 'absolute-fill' | 'none';
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  /** Accepted for API compatibility; the editor timeline is Neon's own. */
  showInTimeline?: boolean;
  /**
   * Give the children their own canvas size: `useVideoConfig()` reports it inside, and the layout
   * box is that many pixels (top-left aligned) instead of filling the parent.
   */
  width?: number;
  height?: number;
  /**
   * Preview only: mount the children this many frames early, hidden and frozen on their first
   * frame, so videos are loaded by the time the sequence starts. Exports render exact frames and
   * ignore it.
   */
  premountFor?: number;
}

/**
 * Time-shifts its children: inside, `useCurrentFrame()` is 0 at `from`, and the children are only
 * mounted for `durationInFrames` frames. `useVideoConfig().durationInFrames` reports the sequence
 * length, so components can anchor exit animations to their own end.
 */
export function Sequence({ from = 0, durationInFrames = Infinity, name, layout = 'absolute-fill', style, className, children, width, height, premountFor = 0 }: SequenceProps): React.ReactElement | null {
  const parent = useContext(SequenceContext);
  const env = useEnvironment();
  const composition = useContext(CompositionContext);
  const abs = useAbsoluteFrame();
  if (!Number.isFinite(from)) throw new Error(`<Sequence from> must be a finite number, got ${from}`);
  if (!(durationInFrames > 0)) throw new Error(`<Sequence durationInFrames> must be > 0, got ${durationInFrames}`);
  const offset = (parent?.offset ?? 0) + from;
  const frozenAt = parent?.frozenAt ?? null;
  const state = useMemo<SequenceState>(() => ({ offset, durationInFrames, frozenAt }), [offset, durationInFrames, frozenAt]);
  const sized = width !== undefined || height !== undefined;
  const resized = useMemo(
    () => (sized && composition ? { ...composition, width: width ?? composition.width, height: height ?? composition.height } : composition),
    [sized, composition, width, height],
  );
  const local = abs - offset;
  const premounting = local < 0 && local >= -premountFor && env.mode === 'player';
  const premountState = useMemo<SequenceState>(() => ({ offset, durationInFrames, frozenAt: offset }), [offset, durationInFrames]);
  if ((local < 0 && !premounting) || local >= durationInFrames) return null;
  let content = <SequenceContext.Provider value={premounting ? premountState : state}>{children}</SequenceContext.Provider>;
  if (sized) content = <CompositionContext.Provider value={resized}>{content}</CompositionContext.Provider>;
  if (layout === 'none') return premounting ? <div style={{ display: 'none' }}>{content}</div> : content;
  let box: React.CSSProperties | undefined = sized
    ? { right: 'auto', bottom: 'auto', width: width ?? '100%', height: height ?? '100%', ...style }
    : style;
  if (premounting) box = { ...box, visibility: 'hidden', pointerEvents: 'none' };
  return (
    <AbsoluteFill style={box} className={className} data-sequence={name}>
      {content}
    </AbsoluteFill>
  );
}

/** Pins its children to one frame (relative to the enclosing sequence). Media inside are paused and silent. */
export function Freeze({ frame, active = true, children }: { frame: number; active?: boolean | ((f: number) => boolean); children?: React.ReactNode }): React.ReactElement {
  const parent = useContext(SequenceContext);
  const current = useCurrentFrame();
  const on = typeof active === 'function' ? active(current) : active;
  const state = useMemo<SequenceState | null>(
    () => (on ? { offset: parent?.offset ?? 0, durationInFrames: parent?.durationInFrames ?? Infinity, frozenAt: (parent?.offset ?? 0) + frame } : parent),
    [on, parent, frame],
  );
  return <SequenceContext.Provider value={state}>{children}</SequenceContext.Provider>;
}

export interface LoopProps {
  durationInFrames: number;
  /** Number of repetitions; Infinity (default) loops forever. */
  times?: number;
  layout?: 'absolute-fill' | 'none';
  name?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Repeats its children every `durationInFrames` frames. */
export function Loop({ durationInFrames, times = Infinity, layout, name, style, children }: LoopProps): React.ReactElement | null {
  const frame = useCurrentFrame();
  if (!(durationInFrames > 0)) throw new Error(`<Loop durationInFrames> must be > 0, got ${durationInFrames}`);
  const iteration = Math.floor(frame / durationInFrames);
  if (iteration < 0 || iteration >= times) return null;
  return (
    <Sequence from={iteration * durationInFrames} durationInFrames={durationInFrames} layout={layout} name={name} style={style}>
      {children}
    </Sequence>
  );
}

export interface SeriesSequenceProps extends Omit<SequenceProps, 'from'> {
  durationInFrames: number;
  /** Shift relative to the end of the previous item (negative overlaps it). */
  offset?: number;
}

function SeriesSequence(_props: SeriesSequenceProps): React.ReactElement {
  throw new Error('<Series.Sequence> must be a direct child of <Series>');
}

/** Plays `<Series.Sequence>` children one after another. */
export function Series({ children }: { children?: React.ReactNode }): React.ReactElement {
  let cursor = 0;
  const items = React.Children.toArray(children).map((child, i) => {
    if (!React.isValidElement(child)) return child;
    if (child.type !== SeriesSequence) throw new Error('Only <Series.Sequence> elements may be children of <Series>');
    const { offset = 0, durationInFrames, ...rest } = child.props as SeriesSequenceProps;
    const from = cursor + offset;
    cursor = from + durationInFrames;
    return <Sequence key={child.key ?? i} {...rest} from={from} durationInFrames={durationInFrames} />;
  });
  return <>{items}</>;
}
Series.Sequence = SeriesSequence;
