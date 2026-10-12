import React, { useLayoutEffect, useRef, useState } from 'react';

/** Measures a container and fits a fixed-size composition into it (letterboxed, centred). */
export function useFit(compositionWidth: number, compositionHeight: number): {
  ref: React.RefObject<HTMLDivElement | null>;
  scale: number;
  left: number;
  top: number;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // getBoundingClientRect includes ancestor transforms; clientWidth/Height are layout px.
      setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth || r.width, height: el.clientHeight || r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size.width > 0 && size.height > 0 ? Math.min(size.width / compositionWidth, size.height / compositionHeight) : 0;
  return {
    ref,
    scale,
    left: (size.width - compositionWidth * scale) / 2,
    top: (size.height - compositionHeight * scale) / 2,
  };
}

interface BoundaryState {
  error: Error | null;
}

/** Keeps a crashing composition from taking the whole app down; shows the error in its place. */
export class CompositionErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey: unknown }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey: unknown }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          background: '#1a0000',
          color: '#ff6b6b',
          font: '28px ui-monospace, Menlo, monospace',
          textAlign: 'center',
          whiteSpace: 'pre-wrap',
        }}
      >
        {`Composition error\n${error.message}`}
      </div>
    );
  }
}
