import { useEffect, useRef, useState } from 'react';
import type { Clip } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';
import { FULL_FRAME, positionForCenter, projectCenter, type NaturalBox } from '../lib/transform-math.ts';

interface Guide {
  axis: 'x' | 'y';
  pos: number; // preview px
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
const MIN_BOX_PX = 16;

const tfOf = (c: Clip) => ({ x: c.transform?.x ?? 0.5, y: c.transform?.y ?? 0.5, scale: c.transform?.scale ?? 1, rotation: c.transform?.rotation ?? 0 });

function visualAt(clips: Clip[], frame: number): Clip[] {
  return clips.filter((c) => c.kind !== 'audio' && c.startFrame <= frame && frame < c.startFrame + c.durationFrames);
}

/**
 * Client rects of everything an element actually paints: glyph runs of text nodes, media/canvas/svg
 * elements (images/videos refined to their object-fit:contain area) and boxes with a visible
 * background/border/shadow. Pure layout containers contribute nothing, so a title's box hugs the
 * title instead of covering the frame.
 */
function collectPaintedRects(wrapper: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const push = (r: DOMRect) => {
    if (r.width > 0.5 && r.height > 0.5) rects.push(r);
  };
  const walk = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO') {
      const r = el.getBoundingClientRect();
      const nat = tag === 'IMG'
        ? { w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight }
        : { w: (el as HTMLVideoElement).videoWidth, h: (el as HTMLVideoElement).videoHeight };
      if (cs.objectFit === 'contain' && nat.w > 0 && nat.h > 0 && r.width > 0 && r.height > 0) {
        const s = Math.min(r.width / nat.w, r.height / nat.h);
        push(new DOMRect(r.x + (r.width - nat.w * s) / 2, r.y + (r.height - nat.h * s) / 2, nat.w * s, nat.h * s));
      } else push(r);
      return;
    }
    if (tag === 'CANVAS' || tag === 'svg') {
      push(el.getBoundingClientRect());
      return;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        push(range.getBoundingClientRect());
      }
    }
    const paints =
      (cs.backgroundColor !== 'transparent' && !/rgba\([^)]*,\s*0\)\s*$/.test(cs.backgroundColor)) ||
      cs.backgroundImage !== 'none' ||
      cs.boxShadow !== 'none' ||
      parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
    if (paints) push(el.getBoundingClientRect());
    for (const child of el.children) walk(child);
  };
  for (const child of wrapper.children) walk(child);
  return rects;
}

/**
 * Measure an element's natural (pre-transform) painted bounds. Client rects went through the
 * wrapper's actual CSS matrix (around the frame centre) plus the Player's uniform scale, so both
 * are inverted analytically; rotated elements recover their axis-aligned size from the AABB.
 */
function measureNatural(clipId: string, overlay: HTMLElement, compW: number, compH: number): NaturalBox | null {
  const wrapper = document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement | null;
  if (!wrapper) return null;
  const origin = overlay.getBoundingClientRect();
  if (origin.width < 2 || compW < 2) return null;
  // The wrapper's matrix lives in composition px (the Player scales the whole composition down to
  // the preview), so convert client px → composition px before inverting it.
  const k = origin.width / compW;
  const tf = getComputedStyle(wrapper).transform;
  const m = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf) : new DOMMatrixReadOnly();
  const s = Math.hypot(m.a, m.b) || 1;
  const theta = Math.atan2(m.b, m.a);
  const inv = m.inverse();
  const c0x = compW / 2;
  const c0y = compH / 2;
  const cosA = Math.abs(Math.cos(theta));
  const sinA = Math.abs(Math.sin(theta));
  const det = cosA * cosA - sinA * sinA;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of collectPaintedRects(wrapper)) {
    const qx = (r.x - origin.x) / k + (r.width / k) / 2;
    const qy = (r.y - origin.y) / k + (r.height / k) / 2;
    const p = inv.transformPoint(new DOMPoint(qx - c0x, qy - c0y));
    const cx = c0x + p.x;
    const cy = c0y + p.y;
    const rw = r.width / k;
    const rh = r.height / k;
    let w: number;
    let h: number;
    if (sinA < 0.02) {
      w = rw / s;
      h = rh / s;
    } else if (Math.abs(det) < 0.15) {
      // Near 45° the AABB→rect system is singular; a square estimate keeps the box sane.
      w = h = Math.sqrt(Math.max(1, rw * rh)) / s / (cosA + sinA);
    } else {
      w = Math.max(1, (rw * cosA - rh * sinA) / (s * det));
      h = Math.max(1, (rh * cosA - rw * sinA) / (s * det));
    }
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return null;
  return {
    cx: (minX + maxX) / 2 / compW,
    cy: (minY + maxY) / 2 / compH,
    w: Math.min(1.5, (maxX - minX) / compW),
    h: Math.min(1.5, (maxY - minY) / compH),
  };
}

const boxEq = (a: NaturalBox, b: NaturalBox) =>
  Math.abs(a.cx - b.cx) < 0.002 && Math.abs(a.cy - b.cy) < 0.002 && Math.abs(a.w - b.w) < 0.004 && Math.abs(a.h - b.h) < 0.004;

/** Screen-space box (preview px) of a natural box under a transform: centre, size, rotation. */
function projectBox(nat: NaturalBox, t: { x: number; y: number; scale: number; rotation: number }, width: number, height: number) {
  // The CSS transform pivots on the frame centre (see transform-math.ts) — projectCenter undoes that.
  const { cx, cy } = projectCenter(nat, t, width, height);
  return { cx, cy, w: Math.max(MIN_BOX_PX, nat.w * width * t.scale), h: Math.max(MIN_BOX_PX, nat.h * height * t.scale), rotation: t.rotation };
}

/**
 * Direct manipulation of visual elements over the preview: every FX/image gets a draggable box
 * hugging its painted content (click selects), the selected one grows scale + rotate handles, with
 * soft snapping to the canvas centre / margins / thirds and other elements' centres and edges.
 * The magnet toggle (N / the transport button) turns snapping off; ⌘/Alt disables it while held.
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
  const [bounds, setBounds] = useState<Record<string, NaturalBox>>({});
  const overlayRef = useRef<HTMLDivElement>(null);
  const kbd = kbdFor(editor.bridge.bootstrap.platform);

  // Measure painted bounds after the Player has drawn this frame; a late second pass catches
  // fonts/images that finish decoding after the first paint.
  useEffect(() => {
    if (playing || width < 40) return;
    let cancelled = false;
    const measure = () => {
      const overlay = overlayRef.current;
      if (cancelled || !overlay) return;
      const next: Record<string, NaturalBox> = {};
      let changed = false;
      for (const clip of visualAt(project.clips, frame)) {
        const nat = measureNatural(clip.id, overlay, project.meta.width, project.meta.height);
        if (nat) next[clip.id] = nat;
      }
      setBounds((prev) => {
        const ids = Object.keys(next);
        changed = ids.length !== Object.keys(prev).length || ids.some((id) => !prev[id] || !boxEq(prev[id]!, next[id]!));
        return changed ? next : prev;
      });
      // Share the measurements so the inspector's scale/rotation fields can pivot on the element too.
      for (const [id, nat] of Object.entries(next)) editor.canvasBounds.set(id, nat);
    };
    const raf = requestAnimationFrame(measure);
    const late = setTimeout(measure, 300);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(late);
    };
  }, [project, frame, width, height, playing]);

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

  const natOf = (c: Clip): NaturalBox => bounds[c.id] ?? FULL_FRAME;

  /** Snap targets in preview px, from the canvas fractions and the other elements' content boxes. */
  const buildTargets = (except: Clip) => {
    const xs = new Set(STATIC_TARGETS.map((f) => f * width));
    const ys = new Set(STATIC_TARGETS.map((f) => f * height));
    for (const other of visible) {
      if (other.id === except.id) continue;
      const b = projectBox(natOf(other), tfOf(other), width, height);
      xs.add(b.cx);
      ys.add(b.cy);
      if (!b.rotation) {
        xs.add(b.cx - b.w / 2);
        xs.add(b.cx + b.w / 2);
        ys.add(b.cy - b.h / 2);
        ys.add(b.cy + b.h / 2);
      }
    }
    return { xs: [...xs], ys: [...ys] };
  };

  const snap1 = (value: number, targets: number[]): { value: number; hit: number | null } => {
    let best: number | null = null;
    let bestDist = SNAP_PX;
    for (const target of targets) {
      const d = Math.abs(value - target);
      if (d < bestDist) {
        best = target;
        bestDist = d;
      }
    }
    return { value: best ?? value, hit: best };
  };

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
    const nat = natOf(clip);
    const startBox = projectBox(nat, start, width, height);
    // Box centre is linear in the transform: cx = t.x·width + K.x — snap the box, move the transform.
    const K = { x: startBox.cx - start.x * width, y: startBox.cy - start.y * height };
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
        for (const [get, set, ts, half, axis] of [
          [() => x * width + K.x, (v: number) => (x = (v - K.x) / width), targets.xs, startBox.w / 2, 'x'],
          [() => y * height + K.y, (v: number) => (y = (v - K.y) / height), targets.ys, startBox.h / 2, 'y'],
        ] as const) {
          const centre = snap1(get(), ts);
          const lo = edges ? snap1(get() - half, ts) : { value: 0, hit: null };
          const hi = edges ? snap1(get() + half, ts) : { value: 0, hit: null };
          if (centre.hit !== null) {
            set(centre.value);
            g.push({ axis, pos: centre.hit });
          } else if (lo.hit !== null) {
            set(lo.value + half);
            g.push({ axis, pos: lo.hit });
          } else if (hi.hit !== null) {
            set(hi.value - half);
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
    const rect = overlayRef.current!.getBoundingClientRect();
    const startBox = projectBox(natOf(clip), start, width, height);
    const d0 = Math.hypot(e.clientX - rect.left - startBox.cx, e.clientY - rect.top - startBox.cy) || 1;
    let latest = start;
    const nat = natOf(clip);
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - rect.left - startBox.cx, ev.clientY - rect.top - startBox.cy);
      let scale = Math.min(10, Math.max(0.05, start.scale * (d / d0)));
      if (snapping && !ev.metaKey && !ev.altKey && Math.abs(scale - 1) < 0.05) scale = 1; // soft snap to 100 %
      // Scale about the element's own centre: keep its painted centre where it was.
      latest = { ...start, scale, ...positionForCenter(nat, { scale, rotation: start.rotation }, startBox.cx, startBox.cy, width, height) };
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
    const rect = overlayRef.current!.getBoundingClientRect();
    const startBox = projectBox(natOf(clip), start, width, height);
    const cx = rect.left + startBox.cx;
    const cy = rect.top + startBox.cy;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    const nat = natOf(clip);
    let latest = start;
    const move = (ev: PointerEvent) => {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      let rotation = start.rotation + ((a - a0) * 180) / Math.PI;
      if (snapping && !ev.metaKey && !ev.altKey) {
        const near = Math.round(rotation / 45) * 45; // soft snap to 0/45/90/…
        if (Math.abs(rotation - near) < ROTATION_SNAP_DEG) rotation = near;
      }
      // Rotate about the element's own centre: keep its painted centre where it was.
      latest = { ...start, rotation, ...positionForCenter(nat, { scale: start.scale, rotation }, startBox.cx, startBox.cy, width, height) };
      setLive(latest);
    };
    track(move, () => {
      setLive(null);
      editor.setTransform(clip.id, latest);
    });
  };

  return (
    <div className="canvas-editor" ref={overlayRef} style={{ width, height }}>
      {guides.map((g, i) => (
        <div key={i} className={`canvas-guide ${g.axis}`} style={g.axis === 'x' ? { left: g.pos } : { top: g.pos }} />
      ))}
      {boxes.map((clip) => {
        const isSel = clip.id === selectedId;
        const t = live && live.id === clip.id ? live : { id: clip.id, ...tfOf(clip) };
        const b = projectBox(natOf(clip), t, width, height);
        const deg = Math.round(t.rotation * 10) / 10;
        return (
          <div
            key={clip.id}
            className={`canvas-box${isSel ? '' : ' idle'}`}
            style={{ left: b.cx - b.w / 2, top: b.cy - b.h / 2, width: b.w, height: b.h, transform: deg ? `rotate(${deg}deg)` : undefined }}
            onPointerDown={(e) => beginDrag(clip, e)}
            onDoubleClick={isSel ? () => editor.setTransform(clip.id, null) : undefined}
            title={isSel ? `${clip.name} — drag to move, corners to scale, knob to rotate, double-click to reset (N toggles snapping, ${kbd.snapPause} pauses it)` : clip.name}
          >
            {isSel ? (
              <>
                <span className="canvas-label">
                  {Math.round(t.scale * 100)}%{deg ? ` · ${deg}°` : ''}{snapping ? '' : ' · snap off'}
                </span>
                <div className="canvas-rotate" onPointerDown={(e) => beginRotate(clip, e)} title="Drag to rotate (soft-snaps to 45° steps)" />
                {([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).map(([hx, hy]) => (
                  <div key={`${hx}${hy}`} className="canvas-handle" style={{ left: hx * b.w - 6, top: hy * b.h - 6 }} onPointerDown={(e) => beginScale(clip, e)} />
                ))}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
