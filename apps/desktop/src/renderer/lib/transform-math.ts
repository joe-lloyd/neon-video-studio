/**
 * Geometry shared by the canvas editor and the inspector.
 *
 * The composition applies `translate(T) scale(s) rotate(r)` to a full-frame wrapper, so the CSS
 * pivot is the FRAME centre `o`, not the element's own centre:  p' = o + T + s·R·(p − o).
 * Users expect scale/rotate to pivot on the element, so whenever scale or rotation changes we
 * re-solve T such that the element's painted centre stays where it was.
 */

/** Painted content bounds of an element, in composition fractions, before its transform. */
export interface NaturalBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export const FULL_FRAME: NaturalBox = { cx: 0.5, cy: 0.5, w: 1, h: 1 };

/** Where the element's painted centre lands (in px of a width×height frame) under transform `t`. */
export function projectCenter(nat: NaturalBox, t: Transform, width: number, height: number): { cx: number; cy: number } {
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (nat.cx - 0.5) * width;
  const dy = (nat.cy - 0.5) * height;
  return {
    cx: width / 2 + (t.x - 0.5) * width + t.scale * (cos * dx - sin * dy),
    cy: height / 2 + (t.y - 0.5) * height + t.scale * (sin * dx + cos * dy),
  };
}

/** The (x, y) that puts the element's painted centre at (cx, cy) px for the given scale/rotation. */
export function positionForCenter(nat: NaturalBox, t: Pick<Transform, 'scale' | 'rotation'>, cx: number, cy: number, width: number, height: number): { x: number; y: number } {
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (nat.cx - 0.5) * width;
  const dy = (nat.cy - 0.5) * height;
  return {
    x: 0.5 + (cx - width / 2 - t.scale * (cos * dx - sin * dy)) / width,
    y: 0.5 + (cy - height / 2 - t.scale * (sin * dx + cos * dy)) / height,
  };
}

/** Apply a scale/rotation change while keeping the element's painted centre fixed. */
export function anchoredTransform(nat: NaturalBox, current: Transform, patch: Partial<Pick<Transform, 'scale' | 'rotation'>>, width: number, height: number): Transform {
  const { cx, cy } = projectCenter(nat, current, width, height);
  const next = { ...current, ...patch };
  return { ...next, ...positionForCenter(nat, next, cx, cy, width, height) };
}
