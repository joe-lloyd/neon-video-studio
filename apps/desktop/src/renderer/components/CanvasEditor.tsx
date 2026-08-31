import { useMemo, useState } from 'react';
import type { Clip } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

interface Guide {
  axis: 'x' | 'y';
  pos: number; // 0..1 canvas fraction
}

const SNAP_PX = 7;
/** Canvas snap targets: centre, safe margins, thirds. */
const STATIC_TARGETS = [0.5, 0.08, 0.92, 1 / 3, 2 / 3];

function visualAt(clips: Clip[], frame: number): Clip[] {
  return clips.filter((c) => c.kind !== 'audio' && c.startFrame <= frame && frame < c.startFrame + c.durationFrames);
}

/**
 * Direct manipulation of the selected element over the preview: drag to move, corner handles to
 * scale, with light snapping to the canvas centre / margins / thirds and other elements.
 */
export function CanvasEditor({ width, height }: { width: number; height: number }) {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const frame = useStoreValue(editor.playhead).frame;
  const playing = useStoreValue(editor.playhead).playing;
  const [guides, setGuides] = useState<Guide[]>([]);
  const [live, setLive] = useState<{ id: string; x: number; y: number; scale: number } | null>(null);

  const clip = project.clips.find((c) => c.id === selection[0]);
  const active = clip && clip.kind !== 'audio' && clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames ? clip : null;

  const snapTargets = useMemo(() => {
    const xs = new Set(STATIC_TARGETS);
    const ys = new Set(STATIC_TARGETS);
    if (active) {
      for (const other of visualAt(project.clips, frame)) {
        if (other.id === active.id) continue;
        const t = other.transform ?? { x: 0.5, y: 0.5, scale: 1 };
        xs.add(t.x);
        ys.add(t.y);
        xs.add(t.x - t.scale / 2);
        xs.add(t.x + t.scale / 2);
        ys.add(t.y - t.scale / 2);
        ys.add(t.y + t.scale / 2);
      }
    }
    return { xs: [...xs], ys: [...ys] };
  }, [active, project.clips, frame]);

  if (!active || playing || width < 40) return null;
  const t = live && live.id === active.id ? live : { id: active.id, ...(active.transform ?? { x: 0.5, y: 0.5, scale: 1 }) };
  const boxW = width * t.scale;
  const boxH = height * t.scale;
  const left = t.x * width - boxW / 2;
  const top = t.y * height - boxH / 2;

  const snap = (value: number, targets: number[], sizePx: number): { value: number; hit: number | null } => {
    let best: number | null = null;
    let bestDist = SNAP_PX / sizePx;
    for (const target of targets) {
      const d = Math.abs(value - target);
      if (d < bestDist) {
        best = target;
        bestDist = d;
      }
    }
    return { value: best ?? value, hit: best };
  };

  const beginDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...t };
    let latest = start;
    const move = (ev: PointerEvent) => {
      let x = start.x + (ev.clientX - startX) / width;
      let y = start.y + (ev.clientY - startY) / height;
      const g: Guide[] = [];
      // Snap centre and the element's edges to the targets (disable with ⌘/Alt held).
      if (!ev.metaKey && !ev.altKey) {
        for (const [get, set, targets, size, axis] of [
          [() => x, (v: number) => (x = v), snapTargets.xs, width, 'x'],
          [() => y, (v: number) => (y = v), snapTargets.ys, height, 'y'],
        ] as const) {
          const centre = snap(get(), targets, size);
          const lo = snap(get() - t.scale / 2, targets, size);
          const hi = snap(get() + t.scale / 2, targets, size);
          if (centre.hit !== null) {
            set(centre.value);
            g.push({ axis, pos: centre.hit });
          } else if (lo.hit !== null) {
            set(lo.value + t.scale / 2);
            g.push({ axis, pos: lo.hit });
          } else if (hi.hit !== null) {
            set(hi.value - t.scale / 2);
            g.push({ axis, pos: hi.hit });
          }
        }
      }
      latest = { ...start, x, y };
      setLive({ ...latest, id: active.id });
      setGuides(g);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides([]);
      setLive(null);
      editor.setTransform(active.id, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const beginScale = (e: React.PointerEvent, corner: [number, number]) => {
    e.stopPropagation();
    e.preventDefault();
    const start = { ...t };
    let latest = start;
    const cx = start.x * width;
    const cy = start.y * height;
    const startDist = Math.hypot(e.clientX - (e.currentTarget.closest('.canvas-editor') as HTMLElement).getBoundingClientRect().left - cx, 0) || 1;
    const rect = (e.currentTarget.closest('.canvas-editor') as HTMLElement).getBoundingClientRect();
    const d0 = Math.hypot(e.clientX - rect.left - cx, e.clientY - rect.top - cy) || 1;
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - rect.left - cx, ev.clientY - rect.top - cy);
      let scale = Math.min(10, Math.max(0.05, start.scale * (d / d0)));
      if (!ev.metaKey && !ev.altKey && Math.abs(scale - 1) < 0.05) scale = 1; // snap to 100 %
      latest = { ...start, scale };
      setLive({ ...latest, id: active.id });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      editor.setTransform(active.id, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void startDist;
    void corner;
  };

  return (
    <div className="canvas-editor" style={{ width, height }}>
      {guides.map((g, i) => (
        <div key={i} className={`canvas-guide ${g.axis}`} style={g.axis === 'x' ? { left: g.pos * width } : { top: g.pos * height }} />
      ))}
      <div
        className="canvas-box"
        style={{ left, top, width: boxW, height: boxH }}
        onPointerDown={beginDrag}
        onDoubleClick={() => editor.setTransform(active.id, null)}
        title={`${active.name} — drag to move, corners to scale, double-click to reset (⌘ disables snapping)`}
      >
        <span className="canvas-label">{Math.round(t.scale * 100)}%</span>
        {([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).map(([hx, hy]) => (
          <div key={`${hx}${hy}`} className="canvas-handle" style={{ left: hx * boxW - 6, top: hy * boxH - 6 }} onPointerDown={(e) => beginScale(e, [hx, hy])} />
        ))}
      </div>
    </div>
  );
}
