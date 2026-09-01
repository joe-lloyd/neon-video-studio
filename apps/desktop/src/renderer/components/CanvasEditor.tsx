import { useState } from 'react';
import type { Clip } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

interface Guide {
  axis: 'x' | 'y';
  pos: number; // 0..1 canvas fraction
}

interface LiveTransform {
  id: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

const SNAP_PX = 7;
const ROTATION_SNAP_DEG = 3;
/** Canvas snap targets: centre, safe margins, thirds. */
const STATIC_TARGETS = [0.5, 0.08, 0.92, 1 / 3, 2 / 3];

const tfOf = (c: Clip) => ({ x: c.transform?.x ?? 0.5, y: c.transform?.y ?? 0.5, scale: c.transform?.scale ?? 1, rotation: c.transform?.rotation ?? 0 });

function visualAt(clips: Clip[], frame: number): Clip[] {
  return clips.filter((c) => c.kind !== 'audio' && c.startFrame <= frame && frame < c.startFrame + c.durationFrames);
}

/**
 * Direct manipulation of visual elements over the preview: every FX/image gets a draggable box
 * (click selects), the selected one grows scale + rotate handles, with soft snapping to the canvas
 * centre / margins / thirds and other elements' centres and edges. The magnet toggle (N / the
 * transport button) turns snapping off; ⌘/Alt disables it just while held.
 */
export function CanvasEditor({ width, height }: { width: number; height: number }) {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const snapping = useSelector(editor.ui, (u) => u.snapping);
  const frame = useStoreValue(editor.playhead).frame;
  const playing = useStoreValue(editor.playhead).playing;
  const [guides, setGuides] = useState<Guide[]>([]);
  const [live, setLive] = useState<LiveTransform | null>(null);

  if (playing || width < 40) return null;
  const visible = visualAt(project.clips, frame);
  const selectedId = selection[0];
  // Overlay elements are always grabbable; full-frame video only when selected (its box would
  // otherwise cover the canvas and swallow clicks meant for the FX above it).
  const boxes = visible.filter((c) => c.kind === 'component' || c.kind === 'image' || c.id === selectedId);
  if (boxes.length === 0) return null;
  // Match the composition's stacking so the topmost visual is also the topmost hit target.
  const trackOrder = new Map(project.tracks.map((t, i) => [t.id, i]));
  boxes.sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0));

  const buildTargets = (except: Clip) => {
    const xs = new Set(STATIC_TARGETS);
    const ys = new Set(STATIC_TARGETS);
    for (const other of visible) {
      if (other.id === except.id) continue;
      const t = tfOf(other);
      xs.add(t.x);
      ys.add(t.y);
      if (!t.rotation) {
        xs.add(t.x - t.scale / 2);
        xs.add(t.x + t.scale / 2);
        ys.add(t.y - t.scale / 2);
        ys.add(t.y + t.scale / 2);
      }
    }
    return { xs: [...xs], ys: [...ys] };
  };

  const snap1 = (value: number, targets: number[], sizePx: number): { value: number; hit: number | null } => {
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

  const stageRect = (e: React.PointerEvent) => (e.currentTarget.closest('.canvas-editor') as HTMLElement).getBoundingClientRect();
  const track = (move: (ev: PointerEvent) => void, done: () => void) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const beginDrag = (clip: Clip, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (selectedId !== clip.id) editor.select([clip.id]);
    const start = { id: clip.id, ...tfOf(clip) };
    const targets = buildTargets(clip);
    const startX = e.clientX;
    const startY = e.clientY;
    let latest = start;
    const move = (ev: PointerEvent) => {
      let x = start.x + (ev.clientX - startX) / width;
      let y = start.y + (ev.clientY - startY) / height;
      const g: Guide[] = [];
      if (snapping && !ev.metaKey && !ev.altKey) {
        // A rotated element's edges aren't axis-aligned, so only its centre snaps then.
        const edges = Math.abs(start.rotation) < 0.5;
        for (const [get, set, ts, size, axis] of [
          [() => x, (v: number) => (x = v), targets.xs, width, 'x'],
          [() => y, (v: number) => (y = v), targets.ys, height, 'y'],
        ] as const) {
          const centre = snap1(get(), ts, size);
          const lo = edges ? snap1(get() - start.scale / 2, ts, size) : { value: 0, hit: null };
          const hi = edges ? snap1(get() + start.scale / 2, ts, size) : { value: 0, hit: null };
          if (centre.hit !== null) {
            set(centre.value);
            g.push({ axis, pos: centre.hit });
          } else if (lo.hit !== null) {
            set(lo.value + start.scale / 2);
            g.push({ axis, pos: lo.hit });
          } else if (hi.hit !== null) {
            set(hi.value - start.scale / 2);
            g.push({ axis, pos: hi.hit });
          }
        }
      }
      latest = { ...start, x, y };
      setLive(latest);
      setGuides(g);
    };
    track(move, () => {
      setGuides([]);
      setLive(null);
      editor.setTransform(clip.id, latest);
    });
  };

  const beginScale = (clip: Clip, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const start = { id: clip.id, ...tfOf(clip) };
    const rect = stageRect(e);
    const cx = start.x * width;
    const cy = start.y * height;
    const d0 = Math.hypot(e.clientX - rect.left - cx, e.clientY - rect.top - cy) || 1;
    let latest = start;
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - rect.left - cx, ev.clientY - rect.top - cy);
      let scale = Math.min(10, Math.max(0.05, start.scale * (d / d0)));
      if (snapping && !ev.metaKey && !ev.altKey && Math.abs(scale - 1) < 0.05) scale = 1; // soft snap to 100 %
      latest = { ...start, scale };
      setLive(latest);
    };
    track(move, () => {
      setLive(null);
      editor.setTransform(clip.id, latest);
    });
  };

  const beginRotate = (clip: Clip, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const start = { id: clip.id, ...tfOf(clip) };
    const rect = stageRect(e);
    const cx = rect.left + start.x * width;
    const cy = rect.top + start.y * height;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    let latest = start;
    const move = (ev: PointerEvent) => {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      let rotation = start.rotation + ((a - a0) * 180) / Math.PI;
      if (snapping && !ev.metaKey && !ev.altKey) {
        const near = Math.round(rotation / 45) * 45; // soft snap to 0/45/90/…
        if (Math.abs(rotation - near) < ROTATION_SNAP_DEG) rotation = near;
      }
      latest = { ...start, rotation };
      setLive(latest);
    };
    track(move, () => {
      setLive(null);
      editor.setTransform(clip.id, latest);
    });
  };

  return (
    <div className="canvas-editor" style={{ width, height }}>
      {guides.map((g, i) => (
        <div key={i} className={`canvas-guide ${g.axis}`} style={g.axis === 'x' ? { left: g.pos * width } : { top: g.pos * height }} />
      ))}
      {boxes.map((clip) => {
        const isSel = clip.id === selectedId;
        const t = live && live.id === clip.id ? live : { id: clip.id, ...tfOf(clip) };
        const boxW = width * t.scale;
        const boxH = height * t.scale;
        const left = t.x * width - boxW / 2;
        const top = t.y * height - boxH / 2;
        const deg = Math.round(t.rotation * 10) / 10;
        return (
          <div
            key={clip.id}
            className={`canvas-box${isSel ? '' : ' idle'}`}
            style={{ left, top, width: boxW, height: boxH, transform: deg ? `rotate(${deg}deg)` : undefined }}
            onPointerDown={(e) => beginDrag(clip, e)}
            onDoubleClick={isSel ? () => editor.setTransform(clip.id, null) : undefined}
            title={isSel ? `${clip.name} — drag to move, corners to scale, knob to rotate, double-click to reset (N toggles snapping, ⌘ pauses it)` : clip.name}
          >
            {isSel ? (
              <>
                <span className="canvas-label">
                  {Math.round(t.scale * 100)}%{deg ? ` · ${deg}°` : ''}{snapping ? '' : ' · snap off'}
                </span>
                <div className="canvas-rotate" onPointerDown={(e) => beginRotate(clip, e)} title="Drag to rotate (soft-snaps to 45° steps)" />
                {([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).map(([hx, hy]) => (
                  <div key={`${hx}${hy}`} className="canvas-handle" style={{ left: hx * boxW - 6, top: hy * boxH - 6 }} onPointerDown={(e) => beginScale(clip, e)} />
                ))}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
